package riotapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DDragonVersions caches the Data Dragon version list.
var (
	ddVersions     []string
	ddVersionsMu   sync.Mutex
	ddVersionsTime time.Time
)

const ddragonCDN = "https://ddragon.leagueoflegends.com"

// GetLatestDDragonVersion fetches the latest Data Dragon version (cached for 1 hour).
func GetLatestDDragonVersion() (string, error) {
	ddVersionsMu.Lock()
	defer ddVersionsMu.Unlock()

	if len(ddVersions) > 0 && time.Since(ddVersionsTime) < time.Hour {
		return ddVersions[0], nil
	}

	url := ddragonCDN + "/api/versions.json"
	resp, err := http.Get(url)
	if err != nil {
		return "", fmt.Errorf("ddragon versions: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if err := json.Unmarshal(body, &ddVersions); err != nil {
		return "", err
	}

	ddVersionsTime = time.Now()
	if len(ddVersions) == 0 {
		return "", fmt.Errorf("no ddragon versions found")
	}

	slog.Debug("ddragon: latest version", "version", ddVersions[0])
	return ddVersions[0], nil
}

// ChampionList represents the Data Dragon champion list response.
type ChampionList struct {
	Data map[string]ChampionData `json:"data"`
}

type ChampionData struct {
	ID      string   `json:"id"`
	Key     string   `json:"key"`
	Name    string   `json:"name"`
	Title   string   `json:"title"`
	Blurb   string   `json:"blurb"`
	Tags    []string `json:"tags"`
	Partype string   `json:"partype"`
	Image   struct {
		Full   string `json:"full"`
		Sprite string `json:"sprite"`
		Group  string `json:"group"`
	} `json:"image"`
}

// GetChampions fetches the champion list from Data Dragon (cached).
func GetChampions() (*ChampionList, error) {
	ver, err := GetLatestDDragonVersion()
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("%s/cdn/%s/data/en_US/champion.json", ddragonCDN, ver)
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var cl ChampionList
	if err := json.NewDecoder(resp.Body).Decode(&cl); err != nil {
		return nil, err
	}
	return &cl, nil
}

// ProfileIconList from Data Dragon
type ProfileIconList struct {
	Data map[string]ProfileIconData `json:"data"`
}

// FlexibleInt accepts the mixed ID formats used by Data Dragon. Older
// profile-icon entries use JSON numbers while newer entries are sometimes
// serialized as quoted strings.
type FlexibleInt int

func (id *FlexibleInt) UnmarshalJSON(data []byte) error {
	var number int
	if err := json.Unmarshal(data, &number); err == nil {
		*id = FlexibleInt(number)
		return nil
	}

	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return fmt.Errorf("profile icon id must be a number or string: %w", err)
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		return fmt.Errorf("parse profile icon id %q: %w", text, err)
	}
	*id = FlexibleInt(parsed)
	return nil
}

type ProfileIconData struct {
	ID    FlexibleInt `json:"id"`
	Image struct {
		Full   string `json:"full"`
		Sprite string `json:"sprite"`
		Group  string `json:"group"`
	} `json:"image"`
	Name string `json:"name"`
}

// GetProfileIcons fetches all profile icons from Data Dragon.
func GetProfileIcons() (*ProfileIconList, error) {
	ver, err := GetLatestDDragonVersion()
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("%s/cdn/%s/data/en_US/profileicon.json", ddragonCDN, ver)
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var pil ProfileIconList
	if err := json.NewDecoder(resp.Body).Decode(&pil); err != nil {
		return nil, err
	}
	return &pil, nil
}

// ---------------------------------------------------------------------------
// URL builders for frontend
// ---------------------------------------------------------------------------

// ChampionIconURL returns the CDN URL for a champion's square icon.
func ChampionIconURL(version, championID string) string {
	return fmt.Sprintf("%s/cdn/%s/img/champion/%s.png", ddragonCDN, version, championID)
}

// ChampionSplashURL returns the CDN URL for a champion's splash art.
func ChampionSplashURL(championID string) string {
	return fmt.Sprintf("%s/cdn/img/champion/splash/%s_0.jpg", ddragonCDN, championID)
}

// ProfileIconURL returns the CDN URL for a profile icon by ID.
func ProfileIconURL(version string, iconID int) string {
	return fmt.Sprintf("%s/cdn/%s/img/profileicon/%d.png", ddragonCDN, version, iconID)
}
