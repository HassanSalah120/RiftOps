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
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
)

const (
	// Collection/catalogue endpoints can legitimately be several megabytes,
	// but no LCU response should be allowed to grow without a hard ceiling.
	maxLCUResponseBytes = 32 << 20
	maxLCUErrorBytes    = 8 << 10
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
	// allowInsecure is intentionally unexported so real lockfiles can never
	// opt into plain HTTP. Tests use an httptest HTTP server and set it inside
	// this package only.
	allowInsecure bool
}

// LCUError keeps the HTTP status separate from the redacted, user-facing
// message. Callers must use the status instead of matching broad fragments
// such as "400" because a 400 can mean an invalid payload, not a stale lobby
// or an unsupported route.
type LCUError struct {
	StatusCode int
	Method     string
	Path       string
	Detail     string
	RetryAfter time.Duration
}

func (e *LCUError) Error() string {
	if e == nil {
		return "lcu request failed"
	}
	detail := e.Detail
	if detail == "" {
		detail = http.StatusText(e.StatusCode)
	}
	return fmt.Sprintf("lcu %d on %s %s: %s", e.StatusCode, e.Method, safeLCUPath(e.Path), detail)
}

// RSOAccessToken is the response from /lol-rso-auth/v1/authorization/access-token.
type RSOAccessToken struct {
	// Modern League clients return the JWT under "token"; older builds used
	// "accessToken". Both are accepted and coalesced.
	AccessToken string   `json:"accessToken"`
	Token       string   `json:"token"`
	Expiry      int64    `json:"expiry"`
	Scopes      []string `json:"scopes"`
	Sub         string   `json:"sub"`
	TokenType   string   `json:"tokenType"`
}

// Value returns the usable bearer token regardless of which field carried it.
func (t RSOAccessToken) Value() string {
	if t.AccessToken != "" {
		return t.AccessToken
	}
	return t.Token
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

	lockfileBasesOnce sync.Once
	lockfileBases     []string
	lockfileCacheMu   sync.Mutex
	lockfileCached    *Lockfile
	lockfileCheckedAt time.Time
	lockfileScanning  bool
)

// LockfileSearchBases returns the list of base directories searched for lockfiles.
func LockfileSearchBases() []string {
	lockfileBasesOnce.Do(func() {
		if runtime.GOOS == "darwin" {
			home, _ := os.UserHomeDir()
			lockfileBases = uniquePaths([]string{
				"/Applications",
				filepath.Join(home, "Applications"),
				filepath.Join(home, "Library", "Application Support"),
				"/Library/Application Support",
			})
			return
		}

		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
		bases := []string{localAppData, os.Getenv("USERPROFILE")}
		bases = append(bases, extraBases...)
		bases = append(bases, riotInstallBases()...)
		lockfileBases = uniquePaths(bases)
	})
	out := make([]string, len(lockfileBases))
	copy(out, lockfileBases)
	return out
}

func riotInstallBases() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	data, err := os.ReadFile(filepath.Join(programData, "Riot Games", "RiotClientInstalls.json"))
	if err != nil {
		return nil
	}
	var installs map[string]any
	if json.Unmarshal(data, &installs) != nil {
		return nil
	}
	var bases []string
	for _, raw := range installs {
		path, ok := raw.(string)
		if !ok || strings.TrimSpace(path) == "" {
			continue
		}
		path = filepath.Clean(filepath.FromSlash(path))
		if strings.EqualFold(filepath.Ext(path), ".exe") {
			path = filepath.Dir(path)
		}
		if strings.EqualFold(filepath.Base(path), "Riot Client") {
			path = filepath.Dir(path)
		}
		bases = append(bases, path)
	}
	return bases
}

func uniquePaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		path = filepath.Clean(strings.TrimSpace(path))
		if path == "." || path == "" {
			continue
		}
		key := strings.ToLower(path)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, path)
	}
	return result
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
			paths = append(paths,
				filepath.Join(base, "League of Legends", "lockfile"),
				filepath.Join(base, "Riot Games", "League of Legends", "lockfile"),
			)
		}
	}
	return uniquePaths(paths)
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
			paths = append(paths,
				filepath.Join(base, "Riot Client", "Config", "lockfile"),
				filepath.Join(base, "Riot Games", "Riot Client", "Config", "lockfile"),
			)
		}
	}
	return uniquePaths(paths)
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
		if !riotClientProcessRunning() {
			return nil, errors.New("no running client processes found")
		}
		// Only use CIM when a native process snapshot proves that a client is
		// running but its lockfile lives outside the discovered install paths.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		ps := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('LeagueClientUx.exe', 'RiotClientServices.exe') } | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress")
		hideCommandWindow(ps)
		out, err = ps.Output()
	default:
		return nil, errors.New("process inspection unavailable on this platform")
	}
	if err != nil || len(out) == 0 {
		return nil, errors.New("no running client processes found")
	}
	for _, process := range parseProcessSnapshots(out) {
		if lf, ok := lockfileFromProcess(process); ok {
			return lf, nil
		}
	}
	return nil, errors.New("command line args missing LCU port/token")
}

type processSnapshot struct {
	Name        string `json:"Name"`
	PID         int    `json:"ProcessId"`
	CommandLine string `json:"CommandLine"`
}

// parseProcessSnapshots preserves process boundaries. Searching the complete
// process listing for the first port and first token can accidentally combine
// Riot Client credentials with League credentials during startup.
func parseProcessSnapshots(raw []byte) []processSnapshot {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return nil
	}
	var windows []processSnapshot
	if strings.HasPrefix(text, "[") || strings.HasPrefix(text, "{") {
		if json.Unmarshal([]byte(text), &windows) == nil && len(windows) > 0 {
			return windows
		}
		var single processSnapshot
		if json.Unmarshal([]byte(text), &single) == nil && (single.Name != "" || single.CommandLine != "") {
			return []processSnapshot{single}
		}
	}

	// macOS ps output is `pid command`; retain the full command after the PID.
	var snapshots []processSnapshot
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		command := strings.TrimSpace(line[len(fields[0]):])
		name := filepath.Base(strings.Fields(command)[0])
		snapshots = append(snapshots, processSnapshot{Name: name, PID: pid, CommandLine: command})
	}
	return snapshots
}

func lockfileFromProcess(process processSnapshot) (*Lockfile, bool) {
	command := process.CommandLine
	name := strings.ToLower(process.Name + " " + command)
	if !strings.Contains(name, "leagueclientux") && !strings.Contains(name, "riotclientservices") {
		return nil, false
	}
	portMatch := regexp.MustCompile(`(?:^|\s)--app-port=(\d+)`).FindStringSubmatch(command)
	tokenMatch := regexp.MustCompile(`(?:^|\s)--remoting-auth-token=([A-Za-z0-9._~-]+)`).FindStringSubmatch(command)
	if len(portMatch) < 2 || len(tokenMatch) < 2 {
		return nil, false
	}
	port, err := strconv.Atoi(portMatch[1])
	if err != nil || port < 1 || port > 65535 {
		return nil, false
	}
	source := "riot-client"
	if strings.Contains(name, "leagueclientux") {
		source = "league"
	}
	return &Lockfile{
		Name:     process.Name,
		PID:      process.PID,
		Port:     port,
		Password: tokenMatch[1],
		Protocol: "https",
		BaseURL:  fmt.Sprintf("https://127.0.0.1:%d", port),
		Source:   source,
	}, true
}

func parseLockfile(content string) (*Lockfile, error) {
	content = strings.TrimSpace(content)
	parts := strings.SplitN(content, ":", 4)
	if len(parts) != 4 {
		return nil, fmt.Errorf("invalid lockfile: expected 'name:pid:port:password:protocol', got %q", content)
	}
	name := strings.TrimSpace(parts[0])
	passwordAndProtocol := parts[3]
	separator := strings.LastIndexByte(passwordAndProtocol, ':')
	if separator <= 0 || separator == len(passwordAndProtocol)-1 {
		return nil, errors.New("invalid lockfile: password and protocol are required")
	}
	password := strings.TrimSpace(passwordAndProtocol[:separator])
	if name == "" || password == "" {
		return nil, errors.New("invalid lockfile: name and password are required")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || pid < 0 {
		return nil, fmt.Errorf("invalid lockfile: bad process id %q", parts[1])
	}
	port, err := strconv.Atoi(strings.TrimSpace(parts[2]))
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("invalid lockfile: bad port %q", parts[2])
	}
	protocol := strings.ToLower(strings.TrimSpace(passwordAndProtocol[separator+1:]))
	if protocol == "" {
		protocol = "https"
	}
	if protocol != "https" {
		return nil, fmt.Errorf("invalid lockfile: unsupported protocol %q", protocol)
	}

	return &Lockfile{
		Name:     name,
		PID:      pid,
		Port:     port,
		Password: password,
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
	if path == "" || !strings.HasPrefix(path, "/") || strings.ContainsRune(path, '\x00') {
		return nil, errors.New("lcu request path is invalid")
	}
	if err := validateLCUBaseURL(lf.BaseURL); err != nil {
		return nil, err
	}
	parsedBase, _ := url.Parse(lf.BaseURL)
	if parsedBase.Scheme == "http" && !lf.allowInsecure {
		return nil, errors.New("lcu base URL must use HTTPS")
	}
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
		invalidateLockfile(lf)
		return nil, fmt.Errorf("lcu %s %s: %w", method, safeLCUPath(path), err)
	}
	defer resp.Body.Close()

	limit := int64(maxLCUResponseBytes)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		limit = maxLCUErrorBytes
	}
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	truncated := int64(len(responseBody)) > limit
	if truncated {
		responseBody = responseBody[:limit]
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			invalidateLockfile(lf)
		}
		detail := strings.TrimSpace(diagnostics.Redact(string(responseBody)))
		if detail == "" {
			detail = http.StatusText(resp.StatusCode)
		}
		if truncated {
			detail += "… [truncated]"
		}
		return nil, &LCUError{
			StatusCode: resp.StatusCode,
			Method:     method,
			Path:       path,
			Detail:     detail,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}
	if truncated {
		return nil, fmt.Errorf("lcu response exceeded %d bytes on %s %s", maxLCUResponseBytes, method, safeLCUPath(path))
	}

	return responseBody, nil
}

func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 0 || seconds > 300 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

func validateLCUBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return errors.New("lcu base URL is invalid")
	}
	host := strings.TrimSpace(parsed.Hostname())
	if !strings.EqualFold(host, "localhost") {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("lcu base URL must use a loopback address")
		}
	}
	return nil
}

func safeLCUPath(path string) string {
	if index := strings.IndexByte(path, '?'); index >= 0 {
		return path[:index] + "?[REDACTED]"
	}
	return diagnostics.Redact(path)
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
	if cachedToken != "" && time.Now().Before(cachedTokenExp.Add(-5*time.Minute)) {
		value := cachedToken
		tokenMu.Unlock()
		return value, true
	}
	tokenMu.Unlock()

	lf := GetLCULockfile()
	if lf == nil {
		slog.Debug("lcu: no lockfile, falling back to env key")
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

	value := token.Value()
	if value == "" {
		return "", false
	}

	// Riot reports expiry in Unix seconds; the ms multiplication landed in 1970.
	expiresAt := time.Now().Add(time.Hour)
	if token.Expiry > 0 {
		expiresAt = time.Unix(token.Expiry, 0)
	}
	tokenMu.Lock()
	// Another caller may have completed the same request while we were on the
	// network. Prefer its value so concurrent callers converge on one cache.
	if cachedToken != "" && time.Now().Before(cachedTokenExp.Add(-5*time.Minute)) {
		value = cachedToken
		expiresAt = cachedTokenExp
	} else {
		cachedToken = value
		cachedTokenExp = expiresAt
	}
	tokenMu.Unlock()

	slog.Debug("lcu: got RSO access token, expires " + expiresAt.Format(time.RFC3339))
	return value, true
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
	now := time.Now()
	lockfileCacheMu.Lock()
	ttl := 8 * time.Second
	if lockfileCached != nil && lockfileCached.Source == "league" {
		ttl = 30 * time.Second
	} else if lockfileCached != nil {
		ttl = 5 * time.Second
	}
	if !lockfileCheckedAt.IsZero() && now.Sub(lockfileCheckedAt) < ttl {
		cached := lockfileCached
		lockfileCacheMu.Unlock()
		return cached
	}
	if lockfileScanning {
		cached := lockfileCached
		lockfileCacheMu.Unlock()
		return cached
	}
	lockfileScanning = true
	lockfileCacheMu.Unlock()

	lf, err := ReadLockfile()
	lockfileCacheMu.Lock()
	lockfileScanning = false
	// Start the cache TTL after discovery completes. A slow process scan must
	// not make the freshly discovered credentials expire immediately.
	lockfileCheckedAt = time.Now()
	if err != nil {
		lockfileCached = nil
		lockfileCacheMu.Unlock()
		slog.Debug("lcu: no lockfile", "error", err)
		return nil
	}
	lockfileCached = lf
	lockfileCacheMu.Unlock()
	return lf
}

func invalidateLockfile(lockfile *Lockfile) {
	if lockfile == nil {
		return
	}
	lockfileCacheMu.Lock()
	defer lockfileCacheMu.Unlock()
	if lockfileCached != nil && lockfileCached.Port == lockfile.Port && lockfileCached.Password == lockfile.Password {
		lockfileCached = nil
		lockfileCheckedAt = time.Time{}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// LCU Data — fetched directly from the local LCU API.
// ─────────────────────────────────────────────────────────────────────────────

// LCUSummoner is the response from /lol-summoner/v1/current-summoner.
type LCUSummoner struct {
	SummonerID             int64  `json:"summonerId"`
	AccountID              int64  `json:"accountId"`
	PUUID                  string `json:"puuid"`
	DisplayName            string `json:"displayName"`
	GameName               string `json:"gameName"`
	TagLine                string `json:"tagLine"`
	ProfileIconID          int    `json:"profileIconId"`
	SummonerLevel          int    `json:"summonerLevel"`
	XPUntilNextLevel       int64  `json:"xpUntilNextLevel"`
	PercentCompleteForNext int    `json:"percentCompleteForNext"`
}

// Name returns the best available summoner name: gameName#tagLine (Riot ID),
// falling back to displayName for legacy accounts.
func (s *LCUSummoner) Name() string {
	if s.GameName != "" {
		if s.TagLine != "" {
			return s.GameName + "#" + s.TagLine
		}
		return s.GameName
	}
	if s.DisplayName != "" {
		return s.DisplayName
	}
	return "Unknown"
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
	Summoner     *LCUSummoner         `json:"summoner,omitempty"`
	League       []LCULeagueEntry     `json:"league,omitempty"`
	Mastery      []LCUChampionMastery `json:"mastery,omitempty"`
	LeagueError  string               `json:"leagueError,omitempty"`
	MasteryError string               `json:"masteryError,omitempty"`
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
		if err := json.Unmarshal(body, &stats); err == nil {
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
			if err := json.Unmarshal(body, &stats); err == nil {
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
		if err := json.Unmarshal(body, &mastery); err == nil {
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
			profile.LeagueError = err.Error()
			slog.Debug("lcu: failed to fetch league entries", "error", err)
		}
	}()

	go func() {
		defer wg.Done()
		mastery, err := lf.FetchLCUMastery(ctx, 6)
		if err == nil {
			profile.Mastery = mastery
		} else {
			profile.MasteryError = err.Error()
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
		// A live League lockfile means the client is already open. Do not
		// relaunch it, which can create duplicate UX processes and slow startup.
		if lf.Source == "league" {
			checkCtx, checkCancel := context.WithTimeout(ctx, 2*time.Second)
			_, phaseErr := lf.GetGameflowPhase(checkCtx)
			checkCancel()
			if phaseErr == nil {
				slog.Info("lcu: League is already running; reusing existing client")
				return nil
			}
			// A League process with a valid lockfile is already starting. Wait
			// for its gameflow service instead of launching a duplicate UX
			// process through the OS fallback.
			return waitForLeagueReady(ctx)
		}
		// Try the Riot Client product-launcher API first. Use the shared LCU
		// transport so loopback validation, auth, bounded responses, and useful
		// status errors are consistent with every other endpoint.
		launchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, launchErr := lf.doJSON(launchCtx, http.MethodPost, "/product-launcher/v1/products/league_of_legends/launch", map[string]any{})
		cancel()
		if launchErr == nil {
			slog.Info("lcu: launched League via Riot Client API")
			return waitForLeagueReady(ctx)
		}
		slog.Debug("lcu: product launcher request failed; using OS fallback", "error", launchErr)
	}

	if err := launchLeagueFallback(ctx); err != nil {
		return err
	}
	return waitForLeagueReady(ctx)
}

func waitForLeagueReady(ctx context.Context) error {
	readyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		if lf, err := ReadLockfile(); err == nil && lf != nil && lf.Source == "league" {
			phaseCtx, phaseCancel := context.WithTimeout(readyCtx, 2*time.Second)
			_, phaseErr := lf.GetGameflowPhase(phaseCtx)
			phaseCancel()
			if phaseErr == nil {
				return nil
			}
		}
		select {
		case <-readyCtx.Done():
			return fmt.Errorf("League launched but the client did not become ready: %w", readyCtx.Err())
		case <-ticker.C:
		}
	}
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
	if endIdx-begIdx > 50 {
		endIdx = begIdx + 50
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
//
// Do not fall back to /lol-game-data/assets/v1/skins.json here. That endpoint
// is a public catalogue and has no account ownership state, so returning it as
// an inventory makes every skin look unowned in the UI. The UI can still use
// the catalogue separately to enrich the inventory response with metadata.
func (lf *Lockfile) FetchLCUSkins(ctx context.Context) ([]byte, error) {
	var failures []string
	usableJSON := func(body []byte) bool {
		trimmed := bytes.TrimSpace(body)
		return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) && json.Valid(trimmed)
	}

	summoner, err := lf.FetchLCUSummoner(ctx)
	if err == nil && summoner != nil && summoner.SummonerID > 0 {
		path := fmt.Sprintf("/lol-champions/v1/inventories/%d/skins-minimal", summoner.SummonerID)
		body, err := lf.DoRequest(ctx, "GET", path)
		if err == nil && usableJSON(body) {
			return body, nil
		}
		if err != nil {
			failures = append(failures, path+": "+err.Error())
		}
	} else if err != nil {
		failures = append(failures, "current-summoner: "+err.Error())
	} else {
		failures = append(failures, "current-summoner: missing summonerId")
	}

	// Fallback 1: Try local-player champions endpoint
	body, err := lf.DoRequest(ctx, "GET", "/lol-champions/v1/inventories/local-player/champions")
	if err == nil && usableJSON(body) {
		return body, nil
	}
	if err != nil {
		failures = append(failures, "/lol-champions/v1/inventories/local-player/champions: "+err.Error())
	}

	if len(failures) == 0 {
		return nil, errors.New("skin inventory endpoints returned no JSON")
	}
	return nil, fmt.Errorf("skin inventory unavailable: %s", strings.Join(failures, "; "))
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

// DeclineReadyCheck declines an active match ready check. The LCU owns the
// timeout/penalty rules; RiftOps only forwards the explicit user action.
func (lf *Lockfile) DeclineReadyCheck(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-matchmaking/v1/ready-check/decline")
	if err == nil {
		return nil
	}
	if !isRetryableLCURouteError(err) {
		return err
	}
	// Older client builds route the same action through the lobby-team-builder
	// service. Keep the primary endpoint first and only fall back on failure.
	_, fallbackErr := lf.DoRequest(ctx, "POST", "/lol-lobby-team-builder/v1/ready-check/decline")
	if fallbackErr == nil {
		return nil
	}
	return err
}

// AutoRequeue starts searching for a match again in the current lobby.
func (lf *Lockfile) AutoRequeue(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-lobby/v2/lobby/matchmaking/search")
	return err
}

// lobbyQueueInfo is the compact queue description served to the UI.
type lobbyQueueInfo struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	GameMode string `json:"gameMode,omitempty"`
	Category string `json:"category,omitempty"`
	MapID    int    `json:"mapId,omitempty"`
}

// FetchAvailableQueues returns every game-mode queue the client currently
// allows. Modern clients expose the catalogue with availability flags on
// /lol-game-queues; older builds only offer the lobby available-queues list.
func (lf *Lockfile) FetchAvailableQueues(ctx context.Context) ([]byte, error) {
	if body, err := lf.DoRequest(ctx, "GET", "/lol-game-queues/v1/queues"); err == nil {
		var raw []struct {
			ID           int    `json:"id"`
			Description  string `json:"description"`
			GameMode     string `json:"gameMode"`
			Category     string `json:"category"`
			MapID        int    `json:"mapId"`
			Availability string `json:"queueAvailability"`
		}
		if json.Unmarshal(body, &raw) == nil {
			out := make([]lobbyQueueInfo, 0, len(raw))
			for _, queue := range raw {
				if queue.ID <= 0 || !strings.EqualFold(queue.Availability, "Available") {
					continue
				}
				name := queue.Description
				if name == "" {
					name = queue.GameMode
				}
				out = append(out, lobbyQueueInfo{ID: queue.ID, Name: name, GameMode: queue.GameMode, Category: queue.Category, MapID: queue.MapID})
			}
			if len(out) > 0 {
				return json.Marshal(out)
			}
		}
	}
	if body, err := lf.DoRequest(ctx, "GET", "/lol-lobby/v2/lobby/available-queues"); err == nil {
		return body, nil
	}
	return lf.DoRequest(ctx, "GET", "/lol-lobby/v1/lobby/available-queues")
}

// FetchCurrentLobby returns the active lobby state, including its queue ID.
func (lf *Lockfile) FetchCurrentLobby(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-lobby/v2/lobby")
}

// CreateQueueLobby replaces the current lobby with one for the given queue ID.
// If the client already hosts a lobby, it is removed first so LCU can recreate
// it for the requested mode instead of returning 400.
func (lf *Lockfile) CreateQueueLobby(ctx context.Context, queueID int) error {
	if queueID <= 0 {
		return fmt.Errorf("queue ID must be positive")
	}
	payload := map[string]any{"queueId": queueID}
	if _, err := lf.doJSON(ctx, "POST", "/lol-lobby/v2/lobby", payload); err == nil {
		return nil
	} else if !isLobbyExistsError(err) {
		return err
	}
	// Only an explicit "already in lobby" response authorizes replacing the
	// current lobby. Invalid payloads and route errors must never delete it.
	_, _ = lf.DoRequest(ctx, "DELETE", "/lol-lobby/v2/lobby")
	// Small grace period for gameflow to return to None.
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(600 * time.Millisecond):
	}
	_, err := lf.doJSON(ctx, "POST", "/lol-lobby/v2/lobby", payload)
	return err
}

// isLobbyExistsError reports whether LCU rejected creation because a lobby
// already exists (400 with "lobby already exists" or similar).
func isLobbyExistsError(err error) bool {
	if err == nil {
		return false
	}
	var lcuErr *LCUError
	if !errors.As(err, &lcuErr) || (lcuErr.StatusCode != http.StatusBadRequest && lcuErr.StatusCode != http.StatusConflict) {
		return false
	}
	msg := strings.ToLower(lcuErr.Detail)
	return strings.Contains(msg, "lobby") &&
		(strings.Contains(msg, "already exists") || strings.Contains(msg, "lobby exists") || strings.Contains(msg, "already in lobby") || strings.Contains(msg, "already in a lobby") || strings.Contains(msg, "already have a lobby"))
}

// CreateCustomLobby creates a custom game lobby for modes whose category is
// "Custom" (e.g. SR Draft Pick Custom, Howling Abyss custom). These queues
// are not matchmade — LCU expects isCustom+customGameLobby instead of queueId.
func (lf *Lockfile) CreateCustomLobby(ctx context.Context, queueID int, gameMode, queueName string, mapID int) error {
	if queueID <= 0 {
		return fmt.Errorf("queue ID must be positive")
	}
	// Preserve the queue catalogue's mode and map. Riot can add event customs
	// whose map/mode cannot be inferred from CLASSIC versus ARAM.
	normalizedMode := strings.ToUpper(strings.TrimSpace(gameMode))
	if normalizedMode == "" {
		normalizedMode = "CLASSIC"
	}
	if mapID <= 0 {
		mapID = 11
		if normalizedMode == "ARAM" || strings.HasPrefix(normalizedMode, "KIWI") {
			mapID = 12
		}
	}
	lobbyName := strings.TrimSpace(queueName)
	if lobbyName == "" {
		lobbyName = fmt.Sprintf("RiftOps Custom %d", queueID)
	}
	if len(lobbyName) > 30 {
		lobbyName = lobbyName[:30]
	}
	payload := map[string]any{
		"customGameLobby": map[string]any{
			"configuration": map[string]any{
				"gameMode":              normalizedMode,
				"gameMutator":           "",
				"gameServerRegion":      "",
				"gameTypeConfig":        map[string]int{"id": 1},
				"mapId":                 mapID,
				"maxPlayerCount":        0,
				"mutators":              map[string]int{"id": 1},
				"spectatorDelayEnabled": false,
				"spectatorPolicy":       "AllAllowed",
				"teamSize":              5,
			},
			"lobbyName":     lobbyName,
			"lobbyPassword": "",
		},
		"isCustom": true,
		"queueId":  queueID,
	}
	if _, err := lf.doJSON(ctx, "POST", "/lol-lobby/v2/lobby", payload); err == nil {
		return nil
	} else if !isLobbyExistsError(err) {
		return err
	}
	_, _ = lf.DoRequest(ctx, "DELETE", "/lol-lobby/v2/lobby")
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(600 * time.Millisecond):
	}
	_, err := lf.doJSON(ctx, "POST", "/lol-lobby/v2/lobby", payload)
	return err
}

// PracticeToolQueueID is the custom-game queue id modern clients use for the
// Practice Tool ("Multiplayer Practice Tool Custom").
const PracticeToolQueueID = 3140

// CreatePracticeToolLobby opens an offline Practice Tool session for testing.
// Modern clients reject the bare custom-game payload unless the practice queue
// ID accompanies it, so the queue rides along at the top level.
func (lf *Lockfile) CreatePracticeToolLobby(ctx context.Context) error {
	payload := map[string]any{
		"customGameLobby": map[string]any{
			"configuration": map[string]any{
				"gameMode":              "PRACTICETOOL",
				"gameMutator":           "",
				"gameServerRegion":      "",
				"gameTypeConfig":        map[string]int{"id": 1},
				"mapId":                 11,
				"maxPlayerCount":        0,
				"mutators":              map[string]int{"id": 1},
				"spectatorDelayEnabled": false,
				"spectatorPolicy":       "NotAllowed",
				"teamSize":              5,
			},
			"lobbyName":     "RiftOps Practice Tool",
			"lobbyPassword": "",
		},
		"isCustom": true,
		"queueId":  PracticeToolQueueID,
	}
	if _, err := lf.doJSON(ctx, "POST", "/lol-lobby/v2/lobby", payload); err == nil {
		return nil
	} else if !isLobbyExistsError(err) {
		return err
	}
	_, _ = lf.DoRequest(ctx, "DELETE", "/lol-lobby/v2/lobby")
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(600 * time.Millisecond):
	}
	_, err := lf.doJSON(ctx, "POST", "/lol-lobby/v2/lobby", payload)
	return err
}

// StopQueue cancels matchmaking for the current lobby.
func (lf *Lockfile) StopQueue(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "DELETE", "/lol-lobby/v2/lobby/matchmaking/search")
	return err
}

// StartCustomGame advances a custom lobby (including Practice Tool) into
// champion select. Custom lobbies use the v1 start-champ-select action rather
// than the v2 matchmaking/search route used by matchmade queues.
func (lf *Lockfile) StartCustomGame(ctx context.Context) error {
	body, err := lf.FetchCurrentLobby(ctx)
	if err != nil {
		return fmt.Errorf("custom lobby is unavailable: %w", err)
	}
	var lobby struct {
		CanStartActivity *bool `json:"canStartActivity"`
		GameConfig       struct {
			IsCustom bool   `json:"isCustom"`
			QueueID  int    `json:"queueId"`
			GameMode string `json:"gameMode"`
		} `json:"gameConfig"`
		IsCustom        bool            `json:"isCustom"`
		CustomGameLobby json.RawMessage `json:"customGameLobby"`
		LocalMember     struct {
			IsLeader             *bool `json:"isLeader"`
			AllowedStartActivity *bool `json:"allowedStartActivity"`
		} `json:"localMember"`
	}
	if err := json.Unmarshal(body, &lobby); err != nil {
		return fmt.Errorf("could not read custom lobby readiness: %w", err)
	}
	isCustom := lobby.IsCustom || lobby.GameConfig.IsCustom || (len(lobby.CustomGameLobby) > 0 && string(lobby.CustomGameLobby) != "null") || lobby.GameConfig.QueueID == PracticeToolQueueID || strings.EqualFold(lobby.GameConfig.GameMode, "PRACTICETOOL")
	if !isCustom {
		return fmt.Errorf("League is currently in a matchmade lobby; create the selected custom lobby first")
	}
	if lobby.LocalMember.IsLeader != nil && !*lobby.LocalMember.IsLeader {
		return fmt.Errorf("only the custom lobby leader can start champion select")
	}
	if lobby.LocalMember.AllowedStartActivity != nil && !*lobby.LocalMember.AllowedStartActivity {
		return fmt.Errorf("only the custom lobby leader can start champion select")
	}
	if lobby.CanStartActivity != nil && !*lobby.CanStartActivity {
		return fmt.Errorf("League reports that the custom lobby is not ready to start yet")
	}
	_, err = lf.DoRequest(ctx, http.MethodPost, "/lol-lobby/v1/lobby/custom/start-champ-select")
	return err
}

// AutoSetRoles sets the preferred primary and secondary roles in a lobby.
func (lf *Lockfile) AutoSetRoles(ctx context.Context, first, second string) error {
	if strings.TrimSpace(first) == "" || strings.TrimSpace(second) == "" {
		return fmt.Errorf("role preferences must not be empty")
	}
	// Tests expect v1 nested first; real LCU v2 now requires flat — try nested
	// first for compatibility, then flat as fallback. Routes v1 then v2 as
	// historically expected by tests.
	payloads := []map[string]any{
		{"positionPreferences": map[string]string{"firstPreference": first, "secondPreference": second}},
		{"positionPreferences": map[string]string{"firstPositionPreference": first, "secondPositionPreference": second}},
		{"firstPreference": first, "secondPreference": second},
		{"firstPositionPreference": first, "secondPositionPreference": second},
	}
	routes := []string{
		"/lol-lobby/v1/lobby/members/localMember/position-preferences",
		"/lol-lobby/v2/lobby/members/localMember/position-preferences",
	}
	var lastErr error
	for _, payload := range payloads {
		for _, route := range routes {
			if _, err := lf.doJSON(ctx, "PUT", route, payload); err == nil {
				return nil
			} else if lastErr = err; !isRetryableLCURouteError(err) {
				return lastErr
			}
		}
	}
	return lastErr
}

// isRetryableLCURouteError reports whether an LCU failure may be resolved by
// trying another route or payload shape (missing route or unsupported schema).
func isRetryableLCURouteError(err error) bool {
	if err == nil {
		return false
	}
	var lcuErr *LCUError
	if !errors.As(err, &lcuErr) {
		return false
	}
	if lcuErr.StatusCode == http.StatusNotFound || lcuErr.StatusCode == http.StatusMethodNotAllowed || lcuErr.StatusCode == http.StatusUnsupportedMediaType {
		return true
	}
	// A few legacy role endpoints return an empty 400 for an unsupported
	// payload shape. Keep that narrow compatibility fallback without treating
	// every LCU 400 as a route mismatch.
	return lcuErr.StatusCode == http.StatusBadRequest && strings.Contains(lcuErr.Path, "position-preferences")
}

// FetchLCULoot returns raw loot inventory JSON for the player (skin shards, essences).
func (lf *Lockfile) FetchLCULoot(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-loot/v1/player-loot")
}

// FetchLCUWallet returns the authoritative RP and blue-essence wallet. League
// has exposed this through both login and store plugins across client versions.
func (lf *Lockfile) FetchLCUWallet(ctx context.Context) ([]byte, error) {
	var lastErr error
	for _, route := range []string{"/lol-login/v1/wallet", "/lol-store/v1/wallet"} {
		body, err := lf.DoRequest(ctx, "GET", route)
		if err == nil {
			return body, nil
		}
		lastErr = err
		if !isRetryableLCURouteError(err) {
			break
		}
	}
	return nil, lastErr
}

// FetchLCULootRecipes returns the live crafting recipes League exposes for an
// inventory item. Keeping recipe discovery in the LCU avoids hard-coded costs
// that become stale when Riot changes the loot system.
func (lf *Lockfile) FetchLCULootRecipes(ctx context.Context, lootID string) ([]byte, error) {
	lootID = strings.TrimSpace(lootID)
	if lootID == "" {
		return nil, fmt.Errorf("loot id is required")
	}
	return lf.DoRequest(ctx, "GET", "/lol-loot/v1/recipes/initial-item/"+url.PathEscape(lootID))
}

// CraftLCULootRecipe executes a recipe selected from FetchLCULootRecipes.
func (lf *Lockfile) CraftLCULootRecipe(ctx context.Context, recipeName string, lootIDs []string, repeat int) ([]byte, error) {
	recipeName = strings.TrimSpace(recipeName)
	if recipeName == "" {
		return nil, fmt.Errorf("recipe name is required")
	}
	if repeat < 1 || repeat > 100 {
		return nil, fmt.Errorf("repeat must be between 1 and 100")
	}
	cleanIDs := make([]string, 0, len(lootIDs))
	for _, lootID := range lootIDs {
		if lootID = strings.TrimSpace(lootID); lootID != "" {
			cleanIDs = append(cleanIDs, lootID)
		}
	}
	if len(cleanIDs) == 0 {
		return nil, fmt.Errorf("at least one loot id is required")
	}
	path := "/lol-loot/v1/recipes/" + url.PathEscape(recipeName) + "/craft?repeat=" + strconv.Itoa(repeat)
	return lf.doJSON(ctx, "POST", path, cleanIDs)
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

// IsCustomSession checks the current LCU payloads before exposing the
// destructive custom/practice quit action. Normal matchmade games must never
// be terminated through this route.
func (lf *Lockfile) IsCustomSession(ctx context.Context) (bool, error) {
	if lobbyBody, err := lf.FetchCurrentLobby(ctx); err == nil {
		var lobby struct {
			IsCustom   bool `json:"isCustom"`
			GameConfig struct {
				QueueID  int    `json:"queueId"`
				IsCustom bool   `json:"isCustom"`
				GameMode string `json:"gameMode"`
			} `json:"gameConfig"`
			CustomGameLobby json.RawMessage `json:"customGameLobby"`
		}
		if json.Unmarshal(lobbyBody, &lobby) == nil {
			if lobby.IsCustom || lobby.GameConfig.IsCustom || len(lobby.CustomGameLobby) > 0 || lobby.GameConfig.QueueID == PracticeToolQueueID || strings.EqualFold(lobby.GameConfig.GameMode, "PRACTICETOOL") {
				return true, nil
			}
			if lobby.GameConfig.QueueID > 0 {
				return false, nil
			}
		}
	}

	if sessionBody, err := lf.DoRequest(ctx, "GET", "/lol-gameflow/v1/session"); err == nil {
		var session struct {
			GameData struct {
				QueueID  int    `json:"queueId"`
				IsCustom bool   `json:"isCustom"`
				GameMode string `json:"gameMode"`
			} `json:"gameData"`
		}
		if json.Unmarshal(sessionBody, &session) == nil {
			return session.GameData.IsCustom || session.GameData.QueueID == PracticeToolQueueID || strings.EqualFold(session.GameData.GameMode, "PRACTICETOOL"), nil
		}
	}
	return false, fmt.Errorf("could not verify a custom or practice session")
}

// QuitCustomSession leaves only a verified custom/practice session. The LCU
// uses different actions for custom Champion Select, an active custom game,
// and a custom lobby.
func (lf *Lockfile) QuitCustomSession(ctx context.Context, phase string) error {
	custom, err := lf.IsCustomSession(ctx)
	if err != nil {
		return err
	}
	if !custom {
		return fmt.Errorf("current session is not a custom or practice game")
	}
	switch phase {
	case "Lobby":
		_, err = lf.DoRequest(ctx, "DELETE", "/lol-lobby/v2/lobby")
	case "Matchmaking":
		err = lf.StopQueue(ctx)
	case "ChampSelect":
		_, err = lf.DoRequest(ctx, "POST", "/lol-lobby-team-builder/champ-select/v1/session/quit")
	case "GameStart", "Loading", "InProgress", "Reconnect":
		_, err = lf.DoRequest(ctx, "POST", "/lol-gameflow/v1/early-exit")
	default:
		return fmt.Errorf("custom/practice quit is not available during %s", phase)
	}
	return err
}

// SetAppearOffline sets the player's presence to offline (true) or online (false).
func (lf *Lockfile) SetAppearOffline(ctx context.Context, offline bool) error {
	availability := "chat"
	if offline {
		availability = "offline"
	}
	return lf.SetAvailability(ctx, availability)
}

func (lf *Lockfile) SetAvailability(ctx context.Context, availability string) error {
	_, err := lf.doJSON(ctx, "PUT", "/lol-chat/v1/me", map[string]string{"availability": availability})
	return err
}

// SetStatusMessage sets a custom chat status/bio message. The chat service
// rate-limits rapid consecutive updates, so one delayed retry is attempted.
func (lf *Lockfile) SetStatusMessage(ctx context.Context, msg string) error {
	for attempt := 0; ; attempt++ {
		_, err := lf.doJSON(ctx, "PUT", "/lol-chat/v1/me", map[string]string{"statusMessage": msg})
		if err == nil || attempt >= 1 || !isTransientLCUError(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(1200 * time.Millisecond):
		}
	}
}

func isTransientLCUError(err error) bool {
	var lcuErr *LCUError
	if !errors.As(err, &lcuErr) {
		return false
	}
	return lcuErr.StatusCode == http.StatusTooManyRequests || lcuErr.StatusCode >= 500
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
	inventoryToken, tokenErr := lf.FetchInventoryToken(ctx)
	payload := map[string]any{"profileIconId": iconID}
	// Newer LCU schemas require inventoryToken; older clients reject unknown
	// or empty token fields. Include it only when the live registration route
	// returned one, letting the server choose the compatible model.
	if tokenErr == nil && inventoryToken != "" {
		payload["inventoryToken"] = inventoryToken
	}
	_, err := lf.doJSON(ctx, "PUT", "/lol-summoner/v1/current-summoner/icon", payload)
	if err != nil && tokenErr != nil {
		slog.Debug("lcu: profile icon request ran without an inventory token", "error", tokenErr)
	}
	return err
}

// LCUProfileIconInventory is the ownership-aware summoner-icon inventory.
// Complete is false when League only exposed the currently equipped icon; in
// that state callers must not assume that other catalogue entries are owned.
type LCUProfileIconInventory struct {
	IconIDs  []int  `json:"iconIds"`
	Complete bool   `json:"complete"`
	Source   string `json:"source"`
}

// FetchLCUProfileIconInventory reads the account inventory instead of the
// public icon catalogue. League has shipped this inventory through several
// routes, so the first usable response wins. The equipped icon is always
// included as a safe fallback, but a fallback-only result is marked incomplete.
func (lf *Lockfile) FetchLCUProfileIconInventory(ctx context.Context) (LCUProfileIconInventory, error) {
	summoner, summonerErr := lf.FetchLCUSummoner(ctx)
	iconIDs := make(map[int]struct{})
	if summonerErr == nil && summoner.ProfileIconID > 0 {
		iconIDs[summoner.ProfileIconID] = struct{}{}
	}

	routes := []string{
		"/lol-collections/v1/inventories/local-player/summoner-icons",
		"/lol-inventory/v1/inventory?inventoryTypes=%5B%22SUMMONER_ICON%22%5D",
		"/lol-inventory/v1/inventory/SUMMONER_ICON",
	}
	if summonerErr == nil && summoner.SummonerID > 0 {
		routes = append([]string{fmt.Sprintf("/lol-collections/v1/inventories/%d/summoner-icons", summoner.SummonerID)}, routes...)
	}

	var failures []string
	for _, route := range routes {
		body, err := lf.DoRequest(ctx, "GET", route)
		if err != nil {
			failures = append(failures, route+": "+err.Error())
			continue
		}
		var payload any
		if err := json.Unmarshal(body, &payload); err != nil {
			failures = append(failures, route+": invalid JSON")
			continue
		}
		routeIconIDs := make(map[int]struct{})
		collectOwnedProfileIconIDs(payload, routeIconIDs)
		if len(routeIconIDs) > 0 {
			for id := range routeIconIDs {
				iconIDs[id] = struct{}{}
			}
			ids := sortedProfileIconIDs(iconIDs)
			return LCUProfileIconInventory{IconIDs: ids, Complete: true, Source: route}, nil
		}
		failures = append(failures, route+": empty inventory")
	}

	if ids := sortedProfileIconIDs(iconIDs); len(ids) > 0 {
		return LCUProfileIconInventory{IconIDs: ids, Complete: false, Source: "current-summoner"}, nil
	}
	if len(failures) == 0 && summonerErr != nil {
		failures = append(failures, summonerErr.Error())
	}
	return LCUProfileIconInventory{}, fmt.Errorf("profile icon inventory unavailable: %s", strings.Join(failures, "; "))
}

func collectOwnedProfileIconIDs(value any, target map[int]struct{}) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectOwnedProfileIconIDs(item, target)
		}
	case map[string]any:
		if id, ok := profileIconRecordID(typed); ok && profileIconRecordOwned(typed) {
			target[id] = struct{}{}
		}
		for _, child := range typed {
			if _, nested := child.(map[string]any); nested {
				collectOwnedProfileIconIDs(child, target)
			} else if _, nested := child.([]any); nested {
				collectOwnedProfileIconIDs(child, target)
			}
		}
	case float64:
		if id := int(typed); typed == float64(id) && id > 0 {
			target[id] = struct{}{}
		}
	case string:
		if id, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil && id > 0 {
			target[id] = struct{}{}
		}
	}
}

func profileIconRecordID(record map[string]any) (int, bool) {
	for _, key := range []string{"summonerIconId", "profileIconId", "iconId", "itemId"} {
		if id, ok := positiveJSONInt(record[key]); ok {
			return id, true
		}
	}
	// Collection records sometimes use a plain id. Only accept it when the
	// surrounding object also carries ownership/icon metadata, avoiding an
	// unrelated envelope id being treated as a profile icon.
	if _, ownership := record["owned"]; ownership {
		if id, ok := positiveJSONInt(record["id"]); ok {
			return id, true
		}
	}
	if _, ownership := record["ownershipType"]; ownership {
		if id, ok := positiveJSONInt(record["id"]); ok {
			return id, true
		}
	}
	return 0, false
}

func positiveJSONInt(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		id := int(typed)
		return id, typed == float64(id) && id > 0
	case int:
		return typed, typed > 0
	case string:
		id, err := strconv.Atoi(strings.TrimSpace(typed))
		return id, err == nil && id > 0
	default:
		return 0, false
	}
}

func profileIconRecordOwned(record map[string]any) bool {
	if owned, present := record["owned"]; present {
		if value, ok := owned.(bool); ok {
			return value
		}
	}
	for _, key := range []string{"quantity", "count"} {
		if value, present := record[key]; present {
			if count, ok := positiveJSONInt(value); !ok || count <= 0 {
				return false
			}
		}
	}
	for _, key := range []string{"ownershipType", "status"} {
		status := strings.ToUpper(strings.TrimSpace(fmt.Sprint(record[key])))
		if strings.Contains(status, "NOT_OWNED") || strings.Contains(status, "UNOWNED") || strings.Contains(status, "LOCKED") {
			return false
		}
	}
	return true
}

func sortedProfileIconIDs(values map[int]struct{}) []int {
	ids := make([]int, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

// FetchInventoryToken returns the current LCU simple-inventory token used by
// account customization requests. The token is exposed only while the LCU
// party registration is ready and is intentionally never persisted.
func (lf *Lockfile) FetchInventoryToken(ctx context.Context) (string, error) {
	body, err := lf.DoRequest(ctx, "GET", "/lol-lobby/v1/parties/player")
	if err != nil {
		return "", err
	}
	var payload struct {
		Registration struct {
			InventoryToken       string   `json:"inventoryToken"`
			InventoryTokens      []string `json:"inventoryTokens"`
			SimpleInventoryToken string   `json:"simpleInventoryToken"`
		} `json:"registration"`
		MultiProductRegistration struct {
			InventoryTokens      []string `json:"inventoryTokens"`
			SimpleInventoryToken string   `json:"simpleInventoryToken"`
		} `json:"multiProductRegistration"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("parse LCU inventory token: %w", err)
	}
	for _, token := range []string{
		payload.Registration.InventoryToken,
		firstNonEmpty(payload.Registration.InventoryTokens),
		firstNonEmpty(payload.MultiProductRegistration.InventoryTokens),
		payload.Registration.SimpleInventoryToken,
		payload.MultiProductRegistration.SimpleInventoryToken,
	} {
		if strings.TrimSpace(token) != "" {
			return token, nil
		}
	}
	return "", fmt.Errorf("lcu inventory token is not ready")
}

func firstNonEmpty(values []string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// GetHonorBallot returns the post-game honor ballot (eligible players to honor).
func (lf *Lockfile) GetHonorBallot(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-honor-v2/v1/ballot")
}

// HonorPlayer submits one post-game honor vote.
func (lf *Lockfile) HonorPlayer(ctx context.Context, summonerID uint64, puuid, honorType string, gameID uint64) error {
	_, err := lf.doJSON(ctx, "POST", "/lol-honor-v2/v1/honor-player", map[string]any{
		"summonerId": summonerID, "puuid": puuid, "gameId": gameID, "honorType": honorType,
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

// ArenaBraveryChampionID is the LCU sentinel used by Arena's Bravery choice.
// It is a special pick only; it is not a valid champion or ban ID.
const ArenaBraveryChampionID = -3

// FetchChampSelectPickable returns the champion ids that the current player
// may pick in the active champion-select session.
func (lf *Lockfile) FetchChampSelectPickable(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-champ-select/v1/pickable-champion-ids")
}

// FetchChampSelectBannable returns the champion ids that may be banned in the
// active champion-select session.
func (lf *Lockfile) FetchChampSelectBannable(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-champ-select/v1/bannable-champion-ids")
}

// FetchChampSelectPickOrderSwaps returns the pick-order swap offers and
// requests currently exposed by League for this champion-select session.
func (lf *Lockfile) FetchChampSelectPickOrderSwaps(ctx context.Context) ([]byte, error) {
	return lf.fetchChampSelectSwapList(ctx, "pick-order-swaps")
}

// FetchChampSelectPositionSwaps returns the role/position swap offers and
// requests currently exposed by League for this champion-select session.
func (lf *Lockfile) FetchChampSelectPositionSwaps(ctx context.Context) ([]byte, error) {
	return lf.fetchChampSelectSwapList(ctx, "position-swaps")
}

func champSelectSwapRoutePrefixes() []string {
	return []string{
		"/lol-champ-select/v1/session/",
		"/lol-lobby-team-builder/champ-select/v1/session/",
	}
}

func (lf *Lockfile) fetchChampSelectSwapList(ctx context.Context, routeKind string) ([]byte, error) {
	var lastErr error
	for _, prefix := range champSelectSwapRoutePrefixes() {
		body, err := lf.DoRequest(ctx, "GET", prefix+routeKind)
		if err == nil {
			return body, nil
		}
		lastErr = err
		if !isRetryableLCURouteError(err) {
			break
		}
	}
	return nil, lastErr
}

// UpdateChampSelectSwap performs one of the LCU's explicit swap transitions.
// These endpoints are undocumented by Riot and are only available when the
// current queue and draft phase support the requested swap.
func (lf *Lockfile) UpdateChampSelectSwap(ctx context.Context, kind, action string, id int) error {
	if id < 0 {
		return fmt.Errorf("champion-select swap ID must not be negative")
	}
	var routeKind string
	switch kind {
	case "pick-order":
		routeKind = "pick-order-swaps"
	case "position":
		routeKind = "position-swaps"
	default:
		return fmt.Errorf("unsupported champion-select swap kind")
	}
	switch action {
	case "request", "accept", "cancel", "decline":
	default:
		return fmt.Errorf("unsupported champion-select swap action")
	}
	var lastErr error
	for _, prefix := range champSelectSwapRoutePrefixes() {
		_, err := lf.DoRequest(ctx, "POST", fmt.Sprintf("%s%s/%d/%s", prefix, routeKind, id, action))
		if err == nil {
			return nil
		}
		lastErr = err
		if !isRetryableLCURouteError(err) {
			break
		}
	}
	return lastErr
}

// UpdateChampSelectAction selects or locks a champion-select action. League's
// LCU uses the same PATCH route for hover/selection and lock-in; omitting
// completed leaves the action unlocked, while completed=true submits it.
// Arena's Bravery choice is the one supported non-positive sentinel.
func (lf *Lockfile) UpdateChampSelectAction(ctx context.Context, actionID, championID int, completed bool) error {
	// Action IDs start at 0 — the very first pick of a draft is a valid,
	// common target, so only reject clearly impossible negatives.
	if actionID < 0 {
		return fmt.Errorf("champion-select action ID must not be negative")
	}
	if championID <= 0 && championID != ArenaBraveryChampionID {
		return fmt.Errorf("champion ID must be positive or Arena Bravery (-3)")
	}
	payload := map[string]any{"championId": championID}
	if completed {
		payload["completed"] = true
	}
	_, err := lf.doJSON(ctx, "PATCH", fmt.Sprintf("/lol-champ-select/v1/session/actions/%d", actionID), payload)
	return err
}

// UpdateChampSelectSelection changes the local player's loadout during the
// finalization phase. Zero values are ignored so callers can update one field
// without accidentally clearing another.
func (lf *Lockfile) UpdateChampSelectSelection(ctx context.Context, spell1ID, spell2ID, skinID int) error {
	payload := make(map[string]any, 3)
	if spell1ID > 0 {
		payload["spell1Id"] = spell1ID
	}
	if spell2ID > 0 {
		payload["spell2Id"] = spell2ID
	}
	if skinID > 0 {
		payload["selectedSkinId"] = skinID
	}
	if len(payload) == 0 {
		return fmt.Errorf("champion-select selection is empty")
	}
	_, err := lf.doJSON(ctx, "PATCH", "/lol-champ-select/v1/session/my-selection", payload)
	return err
}

// FetchChampSelectSkins returns the local player's skin list used by the
// champion-select skin picker. The summoner id is read from the active session
// instead of trusting a client-provided path parameter.
func (lf *Lockfile) FetchChampSelectSkins(ctx context.Context) ([]byte, error) {
	body, err := lf.GetChampSelectSession(ctx)
	if err != nil {
		return nil, err
	}
	var session struct {
		MyTeam []struct {
			CellID     int `json:"cellId"`
			SummonerID int `json:"summonerId"`
		} `json:"myTeam"`
		LocalPlayerCellID int `json:"localPlayerCellId"`
	}
	if err := json.Unmarshal(body, &session); err != nil {
		return nil, fmt.Errorf("parse champion-select session: %w", err)
	}
	for _, member := range session.MyTeam {
		if member.CellID == session.LocalPlayerCellID && member.SummonerID > 0 {
			return lf.DoRequest(ctx, "GET", fmt.Sprintf("/lol-champions/v1/inventories/%d/skins-minimal", member.SummonerID))
		}
	}
	return nil, fmt.Errorf("local champion-select summoner is not ready")
}

// RerollChampSelect consumes an ARAM reroll when the queue supports it.
func (lf *Lockfile) RerollChampSelect(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, "POST", "/lol-champ-select/v1/session/my-selection/reroll")
	return err
}

// SwapBenchChampion swaps an ARAM bench champion into the local selection.
func (lf *Lockfile) SwapBenchChampion(ctx context.Context, championID int) error {
	if championID <= 0 {
		return fmt.Errorf("champion ID must be positive")
	}
	_, err := lf.DoRequest(ctx, "POST", fmt.Sprintf("/lol-champ-select/v1/session/bench/swap/%d", championID))
	return err
}

// FetchRunePages returns the player's editable rune pages.
func (lf *Lockfile) FetchRunePages(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-perks/v1/pages")
}

// FetchRunePerks returns the live perk catalogue, including display metadata
// and slot types used to build a valid editable rune page.
func (lf *Lockfile) FetchRunePerks(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-perks/v1/perks")
}

// FetchRuneStyles returns the live style and slot layout. Keeping this sourced
// from LCU means the editor follows the installed League patch automatically.
func (lf *Lockfile) FetchRuneStyles(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-game-data/assets/v1/perkstyles.json")
}

// CreateRunePage creates a new editable rune page.
func (lf *Lockfile) CreateRunePage(ctx context.Context, payload map[string]any) ([]byte, error) {
	return lf.doJSON(ctx, "POST", "/lol-perks/v1/pages", payload)
}

// UpdateRunePage replaces an editable rune page.
func (lf *Lockfile) UpdateRunePage(ctx context.Context, pageID int, payload map[string]any) error {
	if pageID <= 0 {
		return fmt.Errorf("rune page ID must be positive")
	}
	_, err := lf.doJSON(ctx, "PUT", fmt.Sprintf("/lol-perks/v1/pages/%d", pageID), payload)
	return err
}

// DeleteRunePage removes an editable rune page.
func (lf *Lockfile) DeleteRunePage(ctx context.Context, pageID int) error {
	if pageID <= 0 {
		return fmt.Errorf("rune page ID must be positive")
	}
	_, err := lf.DoRequest(ctx, "DELETE", fmt.Sprintf("/lol-perks/v1/pages/%d", pageID))
	return err
}

// SetCurrentRunePage activates a rune page for the next game.
func (lf *Lockfile) SetCurrentRunePage(ctx context.Context, pageID int) error {
	if pageID <= 0 {
		return fmt.Errorf("rune page ID must be positive")
	}
	payload, err := json.Marshal(pageID)
	if err != nil {
		return err
	}
	_, err = lf.doRequest(ctx, "PUT", "/lol-perks/v1/currentpage", bytes.NewReader(payload))
	return err
}

// FetchLCUFriends returns the League chat friend list. The payload is kept raw
// because Riot adds fields to friend records between client releases.
func (lf *Lockfile) FetchLCUFriends(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, "GET", "/lol-chat/v1/friends")
}

// ClaimEventRewards claims every currently available event-pass reward. Mission
// completion rewards themselves are granted by Riot automatically; the old
// POST /lol-missions/v1/missions/{id} route is not part of current LCU builds.
func (lf *Lockfile) ClaimEventRewards(ctx context.Context) (int, error) {
	body, err := lf.DoRequest(ctx, "GET", "/lol-event-hub/v1/events")
	if err != nil {
		return 0, err
	}
	var events []struct {
		EventID string `json:"eventId"`
	}
	if err := json.Unmarshal(body, &events); err != nil {
		return 0, fmt.Errorf("decode active events: %w", err)
	}
	claimed := 0
	var firstErr error
	for _, event := range events {
		if event.EventID == "" {
			continue
		}
		eventPath := "/lol-event-hub/v1/events/" + url.PathEscape(event.EventID) + "/reward-track"
		unclaimedBody, err := lf.DoRequest(ctx, "GET", eventPath+"/unclaimed-rewards")
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		var unclaimed struct {
			RewardsCount int `json:"rewardsCount"`
		}
		if err := json.Unmarshal(unclaimedBody, &unclaimed); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("decode unclaimed rewards for %s: %w", event.EventID, err)
			}
			continue
		}
		if unclaimed.RewardsCount <= 0 {
			continue
		}
		if _, err := lf.DoRequest(ctx, "POST", eventPath+"/claim-all"); err == nil {
			claimed += unclaimed.RewardsCount
		} else if firstErr == nil {
			firstErr = err
		}
	}
	return claimed, firstErr
}

type QoLState struct {
	Phase          string          `json:"phase"`
	Availability   string          `json:"availability"`
	StatusMessage  string          `json:"statusMessage"`
	ProfileIconID  int             `json:"profileIconId"`
	QueueState     string          `json:"queueState"`
	FirstRole      string          `json:"firstRole"`
	SecondRole     string          `json:"secondRole"`
	BackgroundSkin int             `json:"backgroundSkinId"`
	ReadyCheck     json.RawMessage `json:"readyCheck,omitempty"`
	QueueID        int             `json:"queueId,omitempty"`
	IsCustom       bool            `json:"isCustom,omitempty"`
}

// FetchQoLState gathers the small pieces of client state needed to render the
// QoL dashboard accurately. Optional surfaces are allowed to be unavailable
// outside their relevant gameflow phases.
func (lf *Lockfile) FetchQoLState(ctx context.Context) (QoLState, error) {
	phase, err := lf.GetGameflowPhase(ctx)
	if err != nil {
		return QoLState{}, err
	}
	return lf.FetchQoLStateWithPhase(ctx, phase), nil
}

// FetchQoLStateWithPhase gathers optional state after the caller has already
// read gameflow. It avoids a duplicate phase request in consolidated status
// endpoints while preserving FetchQoLState for existing callers.
func (lf *Lockfile) FetchQoLStateWithPhase(ctx context.Context, phase string) QoLState {
	state := QoLState{Phase: phase}
	if phase == "ReadyCheck" {
		if readyBody, readyErr := lf.DoRequest(ctx, "GET", "/lol-matchmaking/v1/ready-check"); readyErr == nil && json.Valid(readyBody) {
			state.ReadyCheck = json.RawMessage(readyBody)
		}
	}

	// These surfaces are independent. Fetch them together so a slow optional
	// plugin cannot make the entire dashboard appear frozen.
	var chatBody, queueBody, lobbyBody, profileBody []byte
	var requests sync.WaitGroup
	fetch := func(path string, destination *[]byte) {
		defer requests.Done()
		body, requestErr := lf.DoRequest(ctx, "GET", path)
		if requestErr == nil {
			*destination = body
		}
	}
	for _, request := range []struct {
		path        string
		destination *[]byte
	}{
		{"/lol-chat/v1/me", &chatBody},
		{"/lol-lobby/v2/lobby/matchmaking/search-state", &queueBody},
		{"/lol-lobby/v2/lobby", &lobbyBody},
		{"/lol-summoner/v1/current-summoner/summoner-profile", &profileBody},
	} {
		requests.Add(1)
		go fetch(request.path, request.destination)
	}
	requests.Wait()

	if len(chatBody) > 0 {
		var chat struct {
			Availability  string `json:"availability"`
			StatusMessage string `json:"statusMessage"`
			Icon          int    `json:"icon"`
		}
		if json.Unmarshal(chatBody, &chat) == nil {
			state.Availability = chat.Availability
			state.StatusMessage = chat.StatusMessage
			state.ProfileIconID = chat.Icon
		}
	}
	if len(queueBody) > 0 {
		state.QueueState = decodeQueueState(queueBody)
	}
	if len(lobbyBody) > 0 {
		var lobby struct {
			IsCustom   bool `json:"isCustom"`
			GameConfig struct {
				QueueID  int    `json:"queueId"`
				IsCustom bool   `json:"isCustom"`
				GameMode string `json:"gameMode"`
			} `json:"gameConfig"`
			CustomGameLobby json.RawMessage `json:"customGameLobby"`
			LocalMember     struct {
				FirstPositionPreference  string `json:"firstPositionPreference"`
				SecondPositionPreference string `json:"secondPositionPreference"`
			} `json:"localMember"`
		}
		if json.Unmarshal(lobbyBody, &lobby) == nil {
			state.QueueID = lobby.GameConfig.QueueID
			state.IsCustom = lobby.IsCustom || lobby.GameConfig.IsCustom || len(lobby.CustomGameLobby) > 0 || state.QueueID == PracticeToolQueueID || strings.EqualFold(lobby.GameConfig.GameMode, "PRACTICETOOL")
			state.FirstRole = lobby.LocalMember.FirstPositionPreference
			state.SecondRole = lobby.LocalMember.SecondPositionPreference
		}
	}
	if len(profileBody) > 0 {
		var profile struct {
			BackgroundSkinID int `json:"backgroundSkinId"`
		}
		if json.Unmarshal(profileBody, &profile) == nil {
			state.BackgroundSkin = profile.BackgroundSkinID
		}
	}
	return state
}

// decodeQueueState keeps the UI useful across League client revisions. The
// search-state endpoint has returned both a JSON string and an object with a
// searchState/queueState field over time, so do not silently lose the value
// when the shape changes.
func decodeQueueState(body []byte) string {
	var text string
	if json.Unmarshal(body, &text) == nil {
		return strings.TrimSpace(text)
	}
	var payload struct {
		SearchState string `json:"searchState"`
		QueueState  string `json:"queueState"`
		State       string `json:"state"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	for _, value := range []string{payload.SearchState, payload.QueueState, payload.State} {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
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
