package riotapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

// API-key authentication uses the developer portal's X-Riot-Token header.
// When no key is configured, RiftOps can fall back to the local LCU RSO
// bearer token for endpoints that accept it.

// resolveAuth returns credentials for the public Riot API. A developer-portal
// key set via RIOT_API_KEY takes priority; otherwise RiftOps tries the local
// client's RSO token (works where Riot accepts it, e.g. some personal-use
// endpoints). The LCU is re-checked on every call so launching the client
// later is picked up automatically.
func resolveAuth() string {
	key, _ := resolveAuthWithSource()
	return key
}

func resolveAuthWithSource() (string, string) {
	if key := strings.TrimSpace(os.Getenv("RIOT_API_KEY")); key != "" {
		return key, "api-key"
	}
	// Try LCU RSO token first (cached for 5min inside GetRSOAccessToken)
	if token, ok := riotclient.GetRSOAccessToken(); ok {
		slog.Debug("riotapi: auth via LCU RSO token")
		return token, "lcu"
	}
	return "", "none"
}

// IsUsingLCU returns true when local Riot Client authentication is available.
func IsUsingLCU() bool {
	_, source := resolveAuthWithSource()
	return source == "lcu"
}

// ClearAuthCache forces local-token re-resolution on the next call.
func ClearAuthCache() {
	riotclient.ClearTokenCache()
}

// Regions maps common region codes to the API routing value.
var Regions = map[string]string{
	"NA": "americas", "BR": "americas", "LAN": "americas", "LAS": "americas",
	"EUW": "europe", "EUNE": "europe", "TR": "europe", "RU": "europe",
	"KR": "asia", "JP": "asia",
	"OCE": "sea", "PH2": "sea", "SG2": "sea", "TH2": "sea", "VN2": "sea", "TW2": "sea",
}

// Platform maps region codes to the platform routing value used by summoner/league endpoints.
var Platform = map[string]string{
	"NA": "na1", "BR": "br1", "LAN": "la1", "LAS": "la2",
	"EUW": "euw1", "EUNE": "eun1", "TR": "tr1", "RU": "ru",
	"KR": "kr", "JP": "jp1",
	"OCE": "oc1", "PH2": "ph2", "SG2": "sg2", "TH2": "th2", "VN2": "vn2", "TW2": "tw2",
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

type Account struct {
	PUUID    string `json:"puuid"`
	GameName string `json:"gameName"`
	TagLine  string `json:"tagLine"`
}

type Summoner struct {
	ID            string `json:"id"`
	AccountID     string `json:"accountId"`
	PUUID         string `json:"puuid"`
	ProfileIconID int    `json:"profileIconId"`
	RevisionDate  int64  `json:"revisionDate"`
	SummonerLevel int    `json:"summonerLevel"`
}

type ChampionMastery struct {
	ChampionID                   int   `json:"championId"`
	ChampionLevel                int   `json:"championLevel"`
	ChampionPoints               int   `json:"championPoints"`
	LastPlayTime                 int64 `json:"lastPlayTime"`
	ChampionPointsSinceLastLevel int   `json:"championPointsSinceLastLevel"`
	ChampionPointsUntilNextLevel int   `json:"championPointsUntilNextLevel"`
	ChestGranted                 bool  `json:"chestGranted"`
	TokensEarned                 int   `json:"tokensEarned"`
}

type LeagueEntry struct {
	LeagueID     string `json:"leagueId"`
	QueueType    string `json:"queueType"`
	Tier         string `json:"tier"`
	Rank         string `json:"rank"`
	LeaguePoints int    `json:"leaguePoints"`
	Wins         int    `json:"wins"`
	Losses       int    `json:"losses"`
	MiniSeries   *struct {
		Target   int    `json:"target"`
		Wins     int    `json:"wins"`
		Losses   int    `json:"losses"`
		Progress string `json:"progress"`
	} `json:"miniSeries,omitempty"`
}

type CurrentGameInfo struct {
	GameID            int64  `json:"gameId"`
	GameType          string `json:"gameType"`
	GameStartTime     int64  `json:"gameStartTime"`
	MapID             int64  `json:"mapId"`
	GameLength        int64  `json:"gameLength"`
	GameMode          string `json:"gameMode"`
	GameQueueConfigID int    `json:"gameQueueConfigId"`
	Participants      []struct {
		PUUID        string `json:"puuid"`
		SummonerID   string `json:"summonerId"`
		ChampionID   int    `json:"championId"`
		TeamID       int    `json:"teamId"`
		ProfileIcon  int    `json:"profileIconId"`
		SummonerName string `json:"summonerName"`
		PerkIDs      []int  `json:"perkIds,omitempty"`
	} `json:"participants"`
	PlatformID string `json:"platformId"`
}

type RegionStatus struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Locales           []string `json:"locales"`
	MaintenanceStatus string   `json:"maintenanceStatus"`
	Incidents         []struct {
		Active    bool   `json:"active"`
		CreatedAt string `json:"created_at"`
		UpdatedAt string `json:"updated_at"`
		Titles    []struct {
			Content string `json:"content"`
			Locale  string `json:"locale"`
		} `json:"titles"`
	} `json:"incidents"`
}

// ---------------------------------------------------------------------------
// HTTP client with basic rate limiting
// ---------------------------------------------------------------------------

var (
	client = &http.Client{Timeout: 10 * time.Second}
	rlMu   sync.Mutex
	rlLast time.Time
)

func parseRetryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds < 0 || seconds > 300 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

const (
	maxRiotAPIResponseBytes = 8 << 20
	maxRiotAPIErrorBytes    = 8 << 10
)

func doRequest(url string) ([]byte, error) {
	key, authSource := resolveAuthWithSource()
	if key == "" {
		return nil, fmt.Errorf("Riot Client authentication is unavailable; launch Riot Client and sign in")
	}

	// Basic rate limiting: max 20 req/s
	rlMu.Lock()
	elapsed := time.Since(rlLast)
	if elapsed < 50*time.Millisecond {
		time.Sleep(50*time.Millisecond - elapsed)
	}
	rlLast = time.Now()
	rlMu.Unlock()

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	if authSource == "api-key" {
		req.Header.Set("X-Riot-Token", key)
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("riot request failed: %w", err)
	}
	defer resp.Body.Close()

	limit := int64(maxRiotAPIResponseBytes)
	if resp.StatusCode != http.StatusOK {
		limit = maxRiotAPIErrorBytes
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	truncated := int64(len(body)) > limit
	if truncated {
		body = body[:limit]
	}

	if resp.StatusCode != http.StatusOK {
		detail := strings.TrimSpace(diagnostics.Redact(string(body)))
		if detail == "" {
			detail = http.StatusText(resp.StatusCode)
		}
		if truncated {
			detail += "… [truncated]"
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			if retryAfter := parseRetryAfter(resp.Header.Get("Retry-After")); retryAfter > 0 {
				return nil, fmt.Errorf("riot API %d: %s (retry after %s)", resp.StatusCode, detail, retryAfter.Round(time.Second))
			}
		}
		return nil, fmt.Errorf("riot API %d: %s", resp.StatusCode, detail)
	}
	if truncated {
		return nil, fmt.Errorf("riot API response exceeded %d bytes", maxRiotAPIResponseBytes)
	}

	return body, nil
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

// normalizedRegion accepts "euw", " EUW ", and "EUW" alike.
func normalizedRegion(regionCode string) string {
	return strings.ToUpper(strings.TrimSpace(regionCode))
}

// GetAccountByRiotID looks up a Riot account by gameName#tagLine.
// regionCode is a 2-3 letter region like "NA", "EUW", "KR".
func GetAccountByRiotID(regionCode, gameName, tagLine string) (*Account, error) {
	routing, ok := Regions[normalizedRegion(regionCode)]
	if !ok {
		routing = "americas"
	}
	url := fmt.Sprintf("https://%s.api.riotgames.com/riot/account/v1/accounts/by-riot-id/%s/%s",
		routing, gameName, tagLine)
	slog.Debug("riotapi: GetAccountByRiotID", "url", url)
	body, err := doRequest(url)
	if err != nil {
		return nil, err
	}
	var a Account
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// GetSummonerByPUUID fetches summoner info using the PUUID.
func GetSummonerByPUUID(regionCode, puuid string) (*Summoner, error) {
	platform, ok := Platform[normalizedRegion(regionCode)]
	if !ok {
		platform = "na1"
	}
	url := fmt.Sprintf("https://%s.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/%s",
		platform, puuid)
	body, err := doRequest(url)
	if err != nil {
		return nil, err
	}
	var s Summoner
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// GetChampionMastery fetches top champion masteries for a PUUID (default top 6).
func GetChampionMastery(regionCode, puuid string, count int) ([]ChampionMastery, error) {
	platform, ok := Platform[normalizedRegion(regionCode)]
	if !ok {
		platform = "na1"
	}
	if count <= 0 || count > 20 {
		count = 6
	}
	url := fmt.Sprintf("https://%s.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/%s/top?count=%d",
		platform, puuid, count)
	body, err := doRequest(url)
	if err != nil {
		return nil, err
	}
	var m []ChampionMastery
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// GetLeagueEntries fetches ranked league entries (solo/duo, flex) for a summoner ID.
func GetLeagueEntries(regionCode, summonerID string) ([]LeagueEntry, error) {
	platform, ok := Platform[normalizedRegion(regionCode)]
	if !ok {
		platform = "na1"
	}
	url := fmt.Sprintf("https://%s.api.riotgames.com/lol/league/v4/entries/by-summoner/%s",
		platform, summonerID)
	body, err := doRequest(url)
	if err != nil {
		return nil, err
	}
	var entries []LeagueEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// GetCurrentGame fetches current game info for a summoner by PUUID.
func GetCurrentGame(regionCode, puuid string) (*CurrentGameInfo, error) {
	platform, ok := Platform[normalizedRegion(regionCode)]
	if !ok {
		platform = "na1"
	}
	url := fmt.Sprintf("https://%s.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/%s",
		platform, puuid)
	body, err := doRequest(url)
	if err != nil {
		return nil, err
	}
	var g CurrentGameInfo
	if err := json.Unmarshal(body, &g); err != nil {
		return nil, err
	}
	return &g, nil
}

// GetMatchIDs returns Riot Match-V5 IDs for a PUUID. This is an opt-in public
// API path; it is not used as an undocumented LCU substitute and may require a
// developer API key depending on the account/token source.
func GetMatchIDs(regionCode, puuid string, start, count int) ([]string, error) {
	puuid = strings.TrimSpace(puuid)
	if puuid == "" {
		return nil, fmt.Errorf("puuid is required")
	}
	if start < 0 {
		start = 0
	}
	if count <= 0 || count > 100 {
		count = 20
	}
	endpoint := matchV5Endpoint(regionCode, fmt.Sprintf("matches/by-puuid/%s/ids?start=%d&count=%d", url.PathEscape(puuid), start, count))
	body, err := doRequest(endpoint)
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := json.Unmarshal(body, &ids); err != nil {
		return nil, fmt.Errorf("decode match ids: %w", err)
	}
	return ids, nil
}

// GetMatch fetches one Match-V5 DTO as raw JSON so the frontend can retain
// patch-specific fields without RiftOps having to mirror Riot's entire schema.
func GetMatch(regionCode, matchID string) (json.RawMessage, error) {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" {
		return nil, fmt.Errorf("match id is required")
	}
	endpoint := matchV5Endpoint(regionCode, fmt.Sprintf("matches/%s", url.PathEscape(matchID)))
	body, err := doRequest(endpoint)
	if err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("Riot returned invalid match data")
	}
	return json.RawMessage(body), nil
}

// GetMatchTimeline fetches the optional timeline DTO for one Match-V5 game.
func GetMatchTimeline(regionCode, matchID string) (json.RawMessage, error) {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" {
		return nil, fmt.Errorf("match id is required")
	}
	endpoint := matchV5Endpoint(regionCode, fmt.Sprintf("matches/%s/timeline", url.PathEscape(matchID)))
	body, err := doRequest(endpoint)
	if err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("Riot returned invalid match timeline")
	}
	return json.RawMessage(body), nil
}

func matchV5Endpoint(regionCode, suffix string) string {
	routing, ok := Regions[normalizedRegion(regionCode)]
	if !ok {
		routing = "americas"
	}
	return fmt.Sprintf("https://%s.api.riotgames.com/lol/match/v5/%s", routing, strings.TrimLeft(suffix, "/"))
}

// GetRegionStatus fetches the League of Legends service status for a region.
func GetRegionStatus(regionCode string) ([]RegionStatus, error) {
	platform, ok := Platform[normalizedRegion(regionCode)]
	if !ok {
		platform = "na1"
	}
	url := fmt.Sprintf("https://%s.api.riotgames.com/lol/status/v4/platform-data", platform)
	body, err := doRequest(url)
	if err != nil {
		return nil, err
	}
	// The status endpoint returns a wrapper object.
	var wrapper struct {
		ID                string   `json:"id"`
		Name              string   `json:"name"`
		Locales           []string `json:"locales"`
		MaintenanceStatus string   `json:"maintenance_status"`
		Incidents         []struct {
			Active    bool   `json:"active"`
			CreatedAt string `json:"created_at"`
			UpdatedAt string `json:"updated_at"`
			Titles    []struct {
				Content string `json:"content"`
				Locale  string `json:"locale"`
			} `json:"titles"`
		} `json:"incidents"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, err
	}
	return []RegionStatus{{
		ID:                wrapper.ID,
		Name:              wrapper.Name,
		Locales:           wrapper.Locales,
		MaintenanceStatus: wrapper.MaintenanceStatus,
		Incidents:         wrapper.Incidents,
	}}, nil
}

// IsConfigured reports whether local Riot Client authentication is available.
func IsConfigured() bool {
	return resolveAuth() != ""
}

// AuthSource returns where authentication was sourced from.
func AuthSource() string {
	_, source := resolveAuthWithSource()
	return source
}

// GetLCUAvailability returns nil if LCU is not reachable, or the lockfile if it is.
func GetLCUAvailability() *riotclient.Lockfile {
	return riotclient.GetLCULockfile()
}
