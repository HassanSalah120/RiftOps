package riotclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Lockfile holds the parsed contents of the Riot Client LCU lockfile.
type Lockfile struct {
	Name     string
	PID      int
	Port     int
	Password string
	Protocol string
	BaseURL  string
	// Source indicates which lockfile was found: "league" or "riot-client".
	Source string
}

// RSOAccessToken is the response from /lol-rso-auth/v1/authorization/access-token.
type RSOAccessToken struct {
	AccessToken string   `json:"accessToken"`
	Expiry      int64    `json:"expiry"`
	Scopes      []string `json:"scopes"`
	Sub         string   `json:"sub"`
	TokenType   string   `json:"tokenType"`
}

var (
	lockfilePaths = []string{
		// League Client lockfile checked first — it has summoner/league/mastery endpoints.
		// Falls back to Riot Client lockfile (RSO auth only) when League isn't running.
		`League of Legends\lockfile`,
		`Riot Games\Riot Client\Config\lockfile`,
	}

	// Additional base paths to search for lockfiles beyond AppData/UserProfile.
	// The League lockfile lives at the game install dir, which is often D:\Riot Games\League of Legends\.
	extraBases = []string{
		`C:\Riot Games`,
		`D:\Riot Games`,
		`E:\Riot Games`,
		`C:\Program Files\Riot Games`,
		`D:\Program Files\Riot Games`,
	}

	// LCU uses a local self-signed cert on 127.0.0.1 — no MITM risk since it's loopback-only.
	httpClient = &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: "127.0.0.1"},
		},
	}

	cachedToken    string
	cachedTokenExp time.Time
	tokenMu        sync.Mutex
)

// LockfileSearchBases returns the list of base directories searched for lockfiles.
func LockfileSearchBases() []string {
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		return []string{
			"/Applications",
			filepath.Join(home, "Applications"),
			filepath.Join(home, "Library", "Application Support"),
			"/Library/Application Support",
		}
	}

	bases := []string{
		os.Getenv("LOCALAPPDATA"),
		os.Getenv("USERPROFILE"),
	}
	if os.Getenv("LOCALAPPDATA") == "" {
		bases = []string{os.Getenv("USERPROFILE") + `\AppData\Local`}
	}
	bases = append(bases, extraBases...)

	// Dynamically scan all Windows drive letters (C: through Z:) for Riot Games folders
	if runtime.GOOS == "windows" {
		driveLetters := []string{"C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"}
		subDirs := []string{
			`\Riot Games`,
			`\Program Files\Riot Games`,
			`\Program Files (x86)\Riot Games`,
			`\Games\Riot Games`,
		}
		for _, drive := range driveLetters {
			for _, sub := range subDirs {
				path := drive + ":" + sub
				if info, err := os.Stat(path); err == nil && info.IsDir() {
					bases = append(bases, path)
				}
			}
		}
	}
	return bases
}

// LockfileSearchPaths returns the relative lockfile paths searched under each base.
func LockfileSearchPaths() []string {
	out := make([]string, len(lockfilePaths))
	copy(out, lockfilePaths)
	return out
}

// ReadLockfile finds and parses the Riot Client LCU lockfile.
// It searches for League of Legends lockfiles first across all bases,
// and falls back to Riot Client lockfiles if League is not running.
func ReadLockfile() (*Lockfile, error) {
	bases := LockfileSearchBases()

	// Pass 1: Search specifically for League of Legends lockfiles first
	for _, path := range leagueLockfileCandidates(bases) {
		data, err := os.ReadFile(path)
		if err == nil {
			lf, err := parseLockfile(strings.TrimSpace(string(data)))
			if err == nil {
				lf.Source = "league"
				if lockfileResponds(lf) {
					slog.Debug("lcu: found live League lockfile", "path", path, "port", lf.Port)
					return lf, nil
				}
				slog.Debug("lcu: ignoring stale League lockfile", "path", path, "pid", lf.PID, "port", lf.Port)
			}
		}
	}

	// Pass 2: Prefer a live LeagueClientUx process over a Riot Client lockfile.
	// A stale League lockfile can remain after a previous League client exits.
	if lf, err := readLockfileFromProcess(); err == nil && lf.Source == "league" {
		slog.Debug("lcu: obtained League credentials from running process args", "port", lf.Port)
		return lf, nil
	}

	// Pass 3: Search for Riot Client lockfiles.
	for _, path := range riotClientLockfileCandidates(bases) {
		data, err := os.ReadFile(path)
		if err == nil {
			lf, err := parseLockfile(strings.TrimSpace(string(data)))
			if err == nil {
				lf.Source = "riot-client"
				slog.Debug("lcu: found Riot Client lockfile", "path", path, "port", lf.Port)
				return lf, nil
			}
		}
	}

	// Pass 4: Process inspection fallback: check running process command line arguments.
	if lf, err := readLockfileFromProcess(); err == nil {
		slog.Debug("lcu: obtained credentials from running process args", "port", lf.Port, "source", lf.Source)
		return lf, nil
	}

	return nil, fmt.Errorf("LCU lockfile not found — Riot Client may not be running")
}

func leagueLockfileCandidates(bases []string) []string {
	paths := make([]string, 0, len(bases)*2)
	if runtime.GOOS == "darwin" {
		for _, base := range bases {
			if base == "" {
				continue
			}
			// League is distributed as an app bundle on macOS. The LCU lockfile
			// is normally inside Contents/LoL; older client revisions used
			// Contents directly, so retain that fallback.
			paths = append(paths,
				filepath.Join(base, "League of Legends.app", "Contents", "LoL", "lockfile"),
				filepath.Join(base, "League of Legends.app", "Contents", "lockfile"),
			)
		}
		return paths
	}
	for _, base := range bases {
		if base != "" {
			paths = append(paths, filepath.Join(base, `League of Legends\lockfile`))
		}
	}
	return paths
}

func riotClientLockfileCandidates(bases []string) []string {
	paths := make([]string, 0, len(bases))
	if runtime.GOOS == "darwin" {
		for _, base := range bases {
			if base == "" {
				continue
			}
			paths = append(paths, filepath.Join(base, "Riot Games", "Riot Client", "Config", "lockfile"))
		}
		return paths
	}
	for _, base := range bases {
		if base != "" {
			paths = append(paths, filepath.Join(base, `Riot Games\Riot Client\Config\lockfile`))
		}
	}
	return paths
}

// lockfileResponds distinguishes a live League LCU from a stale lockfile left
// behind by a previous client instance. The endpoint is read-only and exists
// whenever the League UX API is ready.
func lockfileResponds(lf *Lockfile) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := lf.DoRequest(ctx, "GET", "/lol-gameflow/v1/gameflow-phase")
	return err == nil
}

func readLockfileFromProcess() (*Lockfile, error) {
	var (
		out []byte
		err error
	)
	switch runtime.GOOS {
	case "darwin":
		// The LCU starts with the same --app-port and
		// --remoting-auth-token arguments on macOS. Reading the process
		// command line also supports non-standard app installation paths.
		out, err = exec.Command("ps", "-axo", "pid=,command=").Output()
	case "windows":
		cmd := exec.Command("wmic", "process", "where", "name='LeagueClientUx.exe' or name='RiotClientServices.exe'", "get", "CommandLine,ProcessId,Name")
		hideCommandWindow(cmd)
		out, err = cmd.Output()
		if err == nil && len(out) > 0 {
			break
		}
		// WMIC was removed from current Windows releases. CIM is the supported
		// replacement and preserves the command-line data needed for the LCU.
		ps := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('LeagueClientUx.exe', 'RiotClientServices.exe') } | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress")
		hideCommandWindow(ps)
		out, err = ps.Output()
	default:
		return nil, errors.New("process inspection unavailable on this platform")
	}
	if err != nil || len(out) == 0 {
		return nil, errors.New("no running client processes found")
	}
	output := string(out)
	portMatch := regexp.MustCompile(`--app-port=(\d+)`).FindStringSubmatch(output)
	tokenMatch := regexp.MustCompile(`--remoting-auth-token=([A-Za-z0-9_-]+)`).FindStringSubmatch(output)
	if len(portMatch) >= 2 && len(tokenMatch) >= 2 {
		port, _ := strconv.Atoi(portMatch[1])
		source := "riot-client"
		if strings.Contains(strings.ToLower(output), "leagueclientux") {
			source = "league"
		}
		return &Lockfile{
			Name:     "LeagueClient",
			PID:      0,
			Port:     port,
			Password: tokenMatch[1],
			Protocol: "https",
			BaseURL:  fmt.Sprintf("https://127.0.0.1:%d", port),
			Source:   source,
		}, nil
	}
	return nil, errors.New("command line args missing LCU port/token")
}

func parseLockfile(content string) (*Lockfile, error) {
	parts := strings.Split(content, ":")
	if len(parts) < 5 {
		return nil, fmt.Errorf("invalid lockfile: expected 'name:pid:port:password:protocol', got %q", content)
	}

	pid := 0
	port := 0
	fmt.Sscanf(parts[1], "%d", &pid)
	fmt.Sscanf(parts[2], "%d", &port)

	protocol := parts[4]
	if protocol == "" {
		protocol = "https"
	}

	return &Lockfile{
		Name:     parts[0],
		PID:      pid,
		Port:     port,
		Password: parts[3],
		Protocol: protocol,
		BaseURL:  fmt.Sprintf("%s://127.0.0.1:%d", protocol, port),
	}, nil
}

// BasicAuthHeader returns the HTTP Basic auth header value for this lockfile.
func (lf *Lockfile) BasicAuthHeader() string {
	auth := base64.StdEncoding.EncodeToString([]byte("riot:" + lf.Password))
	return "Basic " + auth
}

// DoRequest sends an HTTP request to the LCU API and returns the response body.
// The request is cancelled when ctx is done or the client timeout fires.
func (lf *Lockfile) DoRequest(ctx context.Context, method, path string) ([]byte, error) {
	return lf.doRequest(ctx, method, path, nil)
}

func (lf *Lockfile) doRequest(ctx context.Context, method, path string, body io.Reader) ([]byte, error) {
	url := lf.BaseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", lf.BasicAuthHeader())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("lcu %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("lcu %d on %s %s: %s", resp.StatusCode, method, path, string(responseBody))
	}

	return responseBody, nil
}

func (lf *Lockfile) doJSON(ctx context.Context, method, path string, value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return lf.doRequest(ctx, method, path, bytes.NewReader(payload))
}

// FetchRSOAccessToken obtains the RSO access token from the LCU API.
func (lf *Lockfile) FetchRSOAccessToken(ctx context.Context) (*RSOAccessToken, error) {
	body, err := lf.DoRequest(ctx, "GET", "/lol-rso-auth/v1/authorization/access-token")
	if err != nil {
		return nil, err
	}

	var token RSOAccessToken
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, fmt.Errorf("parse RSO token response: %w", err)
	}

	return &token, nil
}

// GetRSOAccessToken attempts to fetch an RSO access token from the LCU API.
// Returns the raw token string and whether the LCU was the source.
func GetRSOAccessToken() (string, bool) {
	tokenMu.Lock()
	defer tokenMu.Unlock()

	if cachedToken != "" && time.Now().Before(cachedTokenExp.Add(-5*time.Minute)) {
		return cachedToken, true
	}

	lf, err := ReadLockfile()
	if err != nil {
		slog.Debug("lcu: no lockfile, falling back to env key", "error", err)
		return "", false
	}

	// Use a short timeout context for the token fetch.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	token, err := lf.FetchRSOAccessToken(ctx)
	if err != nil {
		slog.Debug("lcu: failed to fetch RSO token", "error", err)
		return "", false
	}

	if token.AccessToken == "" {
		return "", false
	}

	cachedToken = token.AccessToken
	cachedTokenExp = time.Unix(0, token.Expiry*int64(time.Millisecond))

	slog.Debug("lcu: got RSO access token, expires " + cachedTokenExp.Format(time.RFC3339))
	return cachedToken, true
}

// ClearTokenCache clears the cached RSO token.
func ClearTokenCache() {
	tokenMu.Lock()
	cachedToken = ""
	cachedTokenExp = time.Time{}
	tokenMu.Unlock()
}

// GetLCULockfile returns the current lockfile if available.
// Returns nil if the Riot Client / League Client isn't running.
func GetLCULockfile() *Lockfile {
	lf, err := ReadLockfile()
	if err != nil {
		slog.Debug("lcu: no lockfile", "error", err)
		return nil
	}
	return lf
}

// ─────────────────────────────────────────────────────────────────────────────
// LCU Data — fetched directly from the local LCU API (no RG_API_KEY needed)
// ─────────────────────────────────────────────────────────────────────────────

// LCUSummoner is the response from /lol-summoner/v1/current-summoner.
type LCUSummoner struct {
	SummonerID             int64  `json:"summonerId"`
	AccountID              int64  `json:"accountId"`
	PUUID                  string `json:"puuid"`
	DisplayName            string `json:"displayName"`
	ProfileIconID          int    `json:"profileIconId"`
	SummonerLevel          int    `json:"summonerLevel"`
	XPUntilNextLevel       int64  `json:"xpUntilNextLevel"`
	PercentCompleteForNext int    `json:"percentCompleteForNext"`
}

// LCULeagueEntry is a single ranked entry from the LCU league endpoint.
type LCULeagueEntry struct {
	QueueType    string `json:"queueType"`
	Tier         string `json:"tier"`
	Rank         string `json:"rank"`
	Division     string `json:"division,omitempty"`
	LeaguePoints int    `json:"leaguePoints"`
	Wins         int    `json:"wins"`
	Losses       int    `json:"losses"`
	MiniSeries   *struct {
		Target   int    `json:"target"`
		Progress string `json:"progress"`
		Wins     int    `json:"wins"`
		Losses   int    `json:"losses"`
	} `json:"miniSeries,omitempty"`
}

// LCUChampionMastery is a single champion mastery entry from the LCU.
type LCUChampionMastery struct {
	ChampionID                   int   `json:"championId"`
	ChampionLevel                int   `json:"championLevel"`
	ChampionPoints               int   `json:"championPoints"`
	LastPlayTime                 int64 `json:"lastPlayTime"`
	ChampionPointsSinceLastLevel int   `json:"championPointsSinceLastLevel"`
	ChampionPointsUntilNextLevel int   `json:"championPointsUntilNextLevel"`
	ChestGranted                 bool  `json:"chestGranted"`
}

// LCUProfile is the aggregated profile data from the LCU.
type LCUProfile struct {
	Summoner *LCUSummoner         `json:"summoner,omitempty"`
	League   []LCULeagueEntry     `json:"league,omitempty"`
	Mastery  []LCUChampionMastery `json:"mastery,omitempty"`
}

// FetchLCUSummoner fetches summoner info from the LCU API directly.
func (lf *Lockfile) FetchLCUSummoner(ctx context.Context) (*LCUSummoner, error) {
	body, err := lf.DoRequest(ctx, "GET", "/lol-summoner/v1/current-summoner")
	if err != nil {
		return nil, err
	}
	var s LCUSummoner
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, fmt.Errorf("parse LCU summoner: %w", err)
	}
	return &s, nil
}

// FetchLCULeague fetches ranked league entries for the current summoner from the LCU.
func (lf *Lockfile) FetchLCULeague(ctx context.Context, puuid string) ([]LCULeagueEntry, error) {
	// Primary endpoint: /lol-ranked/v1/current-ranked-stats
	body, err := lf.DoRequest(ctx, "GET", "/lol-ranked/v1/current-ranked-stats")
	if err == nil {
		var stats struct {
			Queues []LCULeagueEntry `json:"queues"`
		}
		if err := json.Unmarshal(body, &stats); err == nil && len(stats.Queues) > 0 {
			for i := range stats.Queues {
				if stats.Queues[i].Rank == "" && stats.Queues[i].Division != "" {
					stats.Queues[i].Rank = stats.Queues[i].Division
				}
			}
			return stats.Queues, nil
		}
	}

	// Fallback endpoint: /lol-ranked/v1/ranked-stats/{puuid}
	if puuid != "" {
		path := fmt.Sprintf("/lol-ranked/v1/ranked-stats/%s", puuid)
		if body, err := lf.DoRequest(ctx, "GET", path); err == nil {
			var stats struct {
				Queues []LCULeagueEntry `json:"queues"`
			}
			if err := json.Unmarshal(body, &stats); err == nil && len(stats.Queues) > 0 {
				for i := range stats.Queues {
					if stats.Queues[i].Rank == "" && stats.Queues[i].Division != "" {
						stats.Queues[i].Rank = stats.Queues[i].Division
					}
				}
				return stats.Queues, nil
			}
		}
	}

	return nil, fmt.Errorf("no ranked stats available")
}

// FetchLCUMastery fetches top champion masteries from the LCU.
func (lf *Lockfile) FetchLCUMastery(ctx context.Context, limit int) ([]LCUChampionMastery, error) {
	if limit <= 0 || limit > 20 {
		limit = 6
	}

	// Primary endpoint: /lol-champion-mastery/v1/local-player/champion-mastery/top?limit=N
	path := fmt.Sprintf("/lol-champion-mastery/v1/local-player/champion-mastery/top?limit=%d", limit)
	body, err := lf.DoRequest(ctx, "GET", path)
	if err == nil {
		var mastery []LCUChampionMastery
		if err := json.Unmarshal(body, &mastery); err == nil && len(mastery) > 0 {
			return mastery, nil
		}
	}

	return nil, fmt.Errorf("no mastery data available")
}

// FetchLCUProfile fetches the full profile (summoner + league + mastery) from the LCU.
// League and mastery are fetched concurrently after summoner resolves.
func (lf *Lockfile) FetchLCUProfile(ctx context.Context) (*LCUProfile, error) {
	summoner, err := lf.FetchLCUSummoner(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch LCU summoner: %w", err)
	}
	profile := &LCUProfile{Summoner: summoner}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		league, err := lf.FetchLCULeague(ctx, summoner.PUUID)
		if err == nil {
			profile.League = league
		} else {
			slog.Debug("lcu: failed to fetch league entries", "error", err)
		}
	}()

	go func() {
		defer wg.Done()
		mastery, err := lf.FetchLCUMastery(ctx, 6)
		if err == nil {
			profile.Mastery = mastery
		} else {
			slog.Debug("lcu: failed to fetch mastery", "error", err)
		}
	}()

	wg.Wait()
	return profile, nil
}

// LaunchLeague tells the Riot Client LCU to launch League of Legends.
// It tries the Riot Client's product-launcher API first, then uses the
// operating system's app-launch mechanism when the LCU is not ready yet.
func LaunchLeague(ctx context.Context) error {
	lf, err := ReadLockfile()
	if err == nil && lf != nil {
		// Try the Riot Client product-launcher API first.
		launchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		body := strings.NewReader("{}")
		url := lf.BaseURL + "/product-launcher/v1/products/league_of_legends/launch"
		req, apiErr := http.NewRequestWithContext(launchCtx, "POST", url, body)
		if apiErr == nil {
			req.Header.Set("Authorization", lf.BasicAuthHeader())
			req.Header.Set("Content-Type", "application/json")
			resp, httpErr := httpClient.Do(req)
			if httpErr == nil {
				resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					slog.Info("lcu: launched League via Riot Client API")
					return nil
				}
			}
		}
	}

	return launchLeagueFallback(ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
// KO3 LCU Extensions: Match History, Skins & QoL Actions
// ─────────────────────────────────────────────────────────────────────────────

// FetchLCUMatchHistory returns raw match history JSON for the current summoner.
func (lf *Lockfile) FetchLCUMatchHistory(ctx context.Context, begIdx, endIdx int) ([]byte, error) {
	if begIdx < 0 {
		begIdx = 0
	}
	if endIdx <= begIdx {
		endIdx = begIdx + 30
	}
	if endIdx > 50 {
		endIdx = 50
	}

	summoner, err := lf.FetchLCUSummoner(ctx)
	if err == nil && summoner != nil && summoner.PUUID != "" {
		path := fmt.Sprintf("/lol-match-history/v1/products/lol/%s/matches?begIndex=%d&endIndex=%d", summoner.PUUID, begIdx, endIdx)
		body, err := lf.DoRequest(ctx, "GET", path)
		if err == nil && len(body) > 2 {
			return body, nil
		}
	}

	// Fallback to current-summoner endpoint
	path := fmt.Sprintf("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=%d&endIndex=%d", begIdx, endIdx)
	return lf.DoRequest(ctx, "GET", path)
}

// FetchLCUGameDetail returns full game details (all 10 participants, perks, etc.) by gameId.
func (lf *Lockfile) FetchLCUGameDetail(ctx context.Context, gameID int64) ([]byte, error) {
	path := fmt.Sprintf("/lol-match-history/v1/games/%d", gameID)
	return lf.DoRequest(ctx, "GET", path)
}

// FetchLCUSkins returns champion and skin inventory JSON for the local player.
func (lf *Lockfile) FetchLCUSkins(ctx context.Context) ([]byte, error) {
	summoner, err := lf.FetchLCUSummoner(ctx)
	if err == nil && summoner != nil && summoner.SummonerID > 0 {
		path := fmt.Sprintf("/lol-champions/v1/inventories/%d/skins-minimal", summoner.SummonerID)
		body, err := lf.DoRequest(ctx, "GET", path)
		if err == nil && len(body) > 2 {
			return body, nil
		}
	}

	// Fallback 1: Try local-player champions endpoint
	body, err := lf.DoRequest(ctx, "GET", "/lol-champions/v1/inventories/local-player/champions")
	if err == nil && len(body) > 2 {
		return body, nil
	}

	// Fallback 2: Skins database
	return lf.DoRequest(ctx, "GET", "/lol-game-data/assets/v1/skins.json")
}

// FetchLCUChampions returns the local client's champion catalogue. Unlike the
// skin collection endpoint, it is not limited to champions or skins owned by
// the account.
func (lf *Lockfile) FetchLCUChampions(ctx context.Context) ([]byte, error) {
	summoner, err := lf.FetchLCUSummoner(ctx)
	if err != nil {
		return nil, err
	}
	return lf.DoRequest(ctx, "GET", fmt.Sprintf("/lol-champions/v1/inventories/%d/champions-minimal", summoner.SummonerID))
}

// FetchLCUChampionSkins returns every skin that League exposes for one
// champion. Profile backgrounds are cosmetic preferences and are not limited
// to owned skins.
func (lf *Lockfile) FetchLCUChampionSkins(ctx context.Context, championID int) ([]byte, error) {
	if championID <= 0 {
		return nil, fmt.Errorf("champion ID must be positive")
	}
	summoner, err := lf.FetchLCUSummoner(ctx)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/lol-champions/v1/inventories/%d/champions/%d/skins", summoner.SummonerID, championID)
	return lf.DoRequest(ctx, "GET", path)
}

// AcceptReadyCheck accepts an active match ready check pop.
func (lf *Lockfile) AcceptReadyCheck(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-matchmaking/v1/ready-check/accept")
	return err
}

// AutoRequeue starts searching for a match again in the current lobby.
func (lf *Lockfile) AutoRequeue(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-lobby/v2/lobby/matchmaking/search")
	return err
}

// AutoSetRoles sets the preferred primary and secondary roles in a lobby.
func (lf *Lockfile) AutoSetRoles(ctx context.Context, first, second string) error {
	_, err := lf.doJSON(ctx, "PUT", "/lol-lobby/v1/lobby/members/localMember/position-preferences", map[string]string{
		"firstPreference": first, "secondPreference": second,
	})
	return err
}

// FetchLCULoot returns raw loot inventory JSON for the player (skin shards, essences).
func (lf *Lockfile) FetchLCULoot(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-loot/v1/player-loot")
}

// GetGameflowPhase returns the current League client phase (e.g. "Lobby", "ChampSelect", "InProgress").
func (lf *Lockfile) GetGameflowPhase(ctx context.Context) (string, error) {
	body, err := lf.DoRequest(ctx, "GET", "/lol-gameflow/v1/gameflow-phase")
	if err != nil {
		return "", err
	}
	// Response is a quoted JSON string, e.g. "ChampSelect"
	phase := strings.Trim(string(body), `"`)
	return phase, nil
}

// DoDodge asks the current gameflow session to dodge champion select.
func (lf *Lockfile) DoDodge(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-gameflow/v1/session/dodge")
	return err
}

// SetAppearOffline sets the player's presence to offline (true) or online (false).
func (lf *Lockfile) SetAppearOffline(ctx context.Context, offline bool) error {
	availability := "chat"
	if offline {
		availability = "offline"
	}
	_, err := lf.doJSON(ctx, "PUT", "/lol-chat/v1/me", map[string]string{"availability": availability})
	return err
}

// SetStatusMessage sets a custom chat status/bio message.
func (lf *Lockfile) SetStatusMessage(ctx context.Context, msg string) error {
	_, err := lf.doJSON(ctx, "PUT", "/lol-chat/v1/me", map[string]string{"statusMessage": msg})
	return err
}

// SetProfileBackground sets the player's loading screen background skin ID.
func (lf *Lockfile) SetProfileBackground(ctx context.Context, skinID int) error {
	_, err := lf.doJSON(ctx, "POST", "/lol-summoner/v1/current-summoner/summoner-profile", map[string]any{
		"key": "backgroundSkinId", "value": skinID,
	})
	return err
}

// SetProfileIcon changes the player's profile icon.
func (lf *Lockfile) SetProfileIcon(ctx context.Context, iconID int) error {
	_, err := lf.doJSON(ctx, "PUT", "/lol-summoner/v1/current-summoner/icon", map[string]int{"profileIconId": iconID})
	return err
}

// GetHonorBallot returns the post-game honor ballot (eligible players to honor).
func (lf *Lockfile) GetHonorBallot(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-honor-v2/v1/ballot")
}

// HonorPlayer sends an honor to a summoner by ID.
// category is one of: "SHOTCALLER", "HEART", "COOL"
func (lf *Lockfile) HonorPlayer(ctx context.Context, summonerID int64, gameID int64, category string) error {
	_, err := lf.doJSON(ctx, "POST", "/lol-honor-v2/v1/honor-player", map[string]any{
		"summonerId": summonerID, "gameId": gameID, "honorCategory": category,
	})
	return err
}

// PlayAgain skips the end-of-game screen and returns to the lobby.
func (lf *Lockfile) PlayAgain(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-lobby/v2/play-again")
	return err
}

// GetChampSelectSession returns the current champion select session data.
func (lf *Lockfile) GetChampSelectSession(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-champ-select/v1/session")
}

// ClaimMissions claims all claimable missions and returns the count claimed.
func (lf *Lockfile) ClaimMissions(ctx context.Context) (int, error) {
	body, err := lf.DoRequest(ctx, "GET", "/lol-missions/v1/missions")
	if err != nil {
		return 0, err
	}
	type mission struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	var missions []mission
	if err := json.Unmarshal(body, &missions); err != nil {
		var wrapped struct {
			Missions []mission `json:"missions"`
		}
		if wrappedErr := json.Unmarshal(body, &wrapped); wrappedErr != nil || wrapped.Missions == nil {
			return 0, fmt.Errorf("decode missions response: %w", err)
		}
		missions = wrapped.Missions
	}
	claimed := 0
	for _, m := range missions {
		if m.ID != "" && strings.EqualFold(m.Status, "COMPLETED") {
			if _, err := lf.DoRequest(ctx, "POST", "/lol-missions/v1/missions/"+url.PathEscape(m.ID)); err == nil {
				claimed++
			}
		}
	}
	return claimed, nil
}

// findLeagueClient searches known install paths for LeagueClientUx.exe.
func findLeagueClient() (string, error) {
	bases := LockfileSearchBases()
	candidates := []string{"LeagueClientUx.exe", "LeagueClient.exe"}
	for _, base := range bases {
		if base == "" {
			continue
		}
		for _, name := range candidates {
			path := filepath.Join(base, "League of Legends", name)
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				return path, nil
			}
		}
		// Also check directly under base (some installs put it at base root).
		for _, name := range candidates {
			path := filepath.Join(base, name)
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				return path, nil
			}
		}
	}
	return "", fmt.Errorf("League of Legends executable not found in known paths")
}

// FindLeagueClientPath returns the path to LeagueClientUx.exe if installed.
// Returns an empty string if not found (no error).
func FindLeagueClientPath() string {
	path, err := findLeagueClient()
	if err != nil {
		return ""
	}
	return path
}
