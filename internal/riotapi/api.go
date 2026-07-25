package riotapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

// API key is resolved in this priority:
//  1. LCU RSO access token (if Riot Client is running) — Bearer auth
//  2. RG_API_KEY environment variable — X-Riot-Token auth
//
// LCU is re-checked on every call (it's cached internally for 5min),
// so launching the Riot Client later will be picked up automatically.
// The env var is cached once at first read.

var (
	envKey     string
	envKeyOnce sync.Once
	usingLCU   bool
)

// resolveAuth returns the API key and the auth header type to use.
// "Bearer" = Authorization: Bearer <token> (RSO token from LCU)
// "X-Riot-Token" = X-Riot-Token: <key> (legacy API key from env var)
func resolveAuth() (string, string) {
	// Try LCU RSO token first (cached for 5min inside GetRSOAccessToken)
	if token, ok := riotclient.GetRSOAccessToken(); ok {
		usingLCU = true
		slog.Debug("riotapi: auth via LCU RSO token")
		return token, "Bearer"
	}

	usingLCU = false

	// Fall back to env var (cached once)
	envKeyOnce.Do(func() {
		envKey = os.Getenv("RG_API_KEY")
	})
	if envKey != "" {
		return envKey, "X-Riot-Token"
	}

	return "", ""
}

// IsUsingLCU returns true if the current auth is from the LCU RSO token.
func IsUsingLCU() bool {
	resolveAuth() // ensure current state
	return usingLCU
}

// ClearAuthCache forces re-resolution on the next call.
// Called when the LCU connection changes or env var is updated.
func ClearAuthCache() {
	riotclient.ClearTokenCache()
	envKeyOnce = sync.Once{}
	envKey = ""
	usingLCU = false
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
	ChampionID              int   `json:"championId"`
	ChampionLevel           int   `json:"championLevel"`
	ChampionPoints          int   `json:"championPoints"`
	LastPlayTime            int64 `json:"lastPlayTime"`
	ChampionPointsSinceLastLevel int `json:"championPointsSinceLastLevel"`
	ChampionPointsUntilNextLevel int `json:"championPointsUntilNextLevel"`
	ChestGranted            bool  `json:"chestGranted"`
	TokensEarned            int   `json:"tokensEarned"`
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
	ID      string `json:"id"`
	Name    string `json:"name"`
	Locales []string `json:"locales"`
	MaintenanceStatus string `json:"maintenanceStatus"`
	Incidents []struct {
		Active       bool   `json:"active"`
		CreatedAt    string `json:"created_at"`
		UpdatedAt    string `json:"updated_at"`
		Titles []struct {
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

func doRequest(url string) ([]byte, error) {
	key, authType := resolveAuth()
	if key == "" {
		return nil, fmt.Errorf("RIOT API key not set (launch Riot Client or set RG_API_KEY env var)")
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

	// Set the correct auth header based on token type
	if authType == "Bearer" {
		req.Header.Set("Authorization", "Bearer "+key)
	} else {
		req.Header.Set("X-Riot-Token", key)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("riot request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("riot API %d: %s", resp.StatusCode, string(body))
	}

	return body, nil
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

// GetAccountByRiotID looks up a Riot account by gameName#tagLine.
// regionCode is a 2-3 letter region like "NA", "EUW", "KR".
func GetAccountByRiotID(regionCode, gameName, tagLine string) (*Account, error) {
	routing, ok := Regions[regionCode]
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
	platform, ok := Platform[regionCode]
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
	platform, ok := Platform[regionCode]
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
	platform, ok := Platform[regionCode]
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
	platform, ok := Platform[regionCode]
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

// GetRegionStatus fetches the League of Legends service status for a region.
func GetRegionStatus(regionCode string) ([]RegionStatus, error) {
	platform, ok := Platform[regionCode]
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
		ID      string         `json:"id"`
		Name    string         `json:"name"`
		Locales []string       `json:"locales"`
		MaintenanceStatus string `json:"maintenance_status"`
		Incidents []struct {
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

// IsConfigured returns whether a Riot API key is available (from LCU or env var).
func IsConfigured() bool {
	key, _ := resolveAuth()
	return key != ""
}

// AuthSource returns where the API key was sourced from.
func AuthSource() string {
	resolveAuth()
	if usingLCU {
		return "lcu"
	}
	envKeyOnce.Do(func() {
		envKey = os.Getenv("RG_API_KEY")
	})
	if envKey != "" {
		return "env"
	}
	return "none"
}

// GetLCUAvailability returns nil if LCU is not reachable, or the lockfile if it is.
func GetLCUAvailability() *riotclient.Lockfile {
	return riotclient.GetLCULockfile()
}
