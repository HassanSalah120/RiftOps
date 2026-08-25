package riotclient

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	gameClientDefaultURL = "https://127.0.0.1:2999"
	maxGameClientBytes   = 16 << 20
)

// GameClient is the read-only League Game Client Data API. It is deliberately
// separate from the LCU client: the game API has no lockfile authentication,
// a different port, and a different availability window.
type GameClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

// NewGameClient creates a game-data client. Production callers should use the
// default client; the injectable HTTP client keeps parsing tests deterministic.
func NewGameClient(baseURL string, httpClient *http.Client) *GameClient {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = gameClientDefaultURL
	}
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 1200 * time.Millisecond,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: "127.0.0.1"}, // game API uses a local self-signed cert
			},
		}
	}
	return &GameClient{BaseURL: strings.TrimRight(baseURL, "/"), HTTPClient: httpClient}
}

var defaultGameClient = NewGameClient(gameClientDefaultURL, nil)

// GameClientData is a normalized subset of allgamedata. Unknown fields are
// intentionally ignored because Riot changes this local API between patches.
type GameClientData struct {
	Available    bool              `json:"available"`
	UpdatedAt    time.Time         `json:"updatedAt"`
	GameData     GameData          `json:"gameData,omitempty"`
	Arena        map[string]any    `json:"arena,omitempty"`
	ActivePlayer *ActiveGamePlayer `json:"activePlayer,omitempty"`
	Players      []GamePlayer      `json:"players,omitempty"`
	Events       []GameEvent       `json:"events,omitempty"`
}

type GameData struct {
	GameID     StringID       `json:"gameId,omitempty"`
	GameTime   float64        `json:"gameTime,omitempty"`
	QueueID    int            `json:"queueId,omitempty"`
	GameMode   string         `json:"gameMode,omitempty"`
	MapName    string         `json:"mapName,omitempty"`
	MapNumber  int            `json:"mapNumber,omitempty"`
	Mode       string         `json:"mode,omitempty"`
	PlatformID string         `json:"platformId,omitempty"`
	Arena      map[string]any `json:"arena,omitempty"`
}

// StringID accepts both the numeric and string gameId shapes used by recent
// League Game Client builds while keeping the frontend contract stable.
type StringID string

func (id *StringID) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*id = StringID(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	*id = StringID(number.String())
	return nil
}

type ActiveGamePlayer struct {
	SummonerName   string         `json:"summonerName,omitempty"`
	ChampionName   string         `json:"championName,omitempty"`
	Level          int            `json:"level,omitempty"`
	CurrentGold    float64        `json:"currentGold,omitempty"`
	ChampionStats  ChampionStats  `json:"championStats,omitempty"`
	SummonerSpells []GameSpell    `json:"summonerSpells,omitempty"`
	FullRunes      []GameRune     `json:"fullRunes,omitempty"`
	Abilities      map[string]any `json:"abilities,omitempty"`
}

type GamePlayer struct {
	SummonerName   string      `json:"summonerName,omitempty"`
	ChampionName   string      `json:"championName,omitempty"`
	Team           string      `json:"team,omitempty"`
	Position       string      `json:"position,omitempty"`
	Level          int         `json:"level,omitempty"`
	IsBot          bool        `json:"isBot,omitempty"`
	IsDead         bool        `json:"isDead,omitempty"`
	Items          []GameItem  `json:"items,omitempty"`
	Scores         GameScores  `json:"scores,omitempty"`
	SummonerSpells []GameSpell `json:"summonerSpells,omitempty"`
}

type ChampionStats struct {
	AbilityPower float64 `json:"abilityPower,omitempty"`
	AttackDamage float64 `json:"attackDamage,omitempty"`
	Armor        float64 `json:"armor,omitempty"`
	AttackSpeed  float64 `json:"attackSpeed,omitempty"`
	Health       float64 `json:"health,omitempty"`
	HealthMax    float64 `json:"healthMax,omitempty"`
	MoveSpeed    float64 `json:"moveSpeed,omitempty"`
	SpellBlock   float64 `json:"spellBlock,omitempty"`
}

type GameSpell struct {
	DisplayName     string `json:"displayName,omitempty"`
	RawDisplayName  string `json:"rawDisplayName,omitempty"`
	SummonerSpellID string `json:"summonerSpellId,omitempty"`
	AbilitySlot     string `json:"abilitySlot,omitempty"`
}

type GameRune struct {
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	SummonerID  int    `json:"summonerId,omitempty"`
}

type GameItem struct {
	ID          int    `json:"itemID,omitempty"`
	Count       int    `json:"count,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Price       int    `json:"price,omitempty"`
	CanUse      bool   `json:"canUse,omitempty"`
	Consumed    bool   `json:"consumed,omitempty"`
}

type GameScores struct {
	Kills                       int     `json:"kills,omitempty"`
	Deaths                      int     `json:"deaths,omitempty"`
	Assists                     int     `json:"assists,omitempty"`
	KillParticipation           float64 `json:"killParticipation,omitempty"`
	CreepScore                  int     `json:"creepScore,omitempty"`
	WardScore                   float64 `json:"wardScore,omitempty"`
	TotalDamageDealtToChampions int     `json:"totalDamageDealtToChampions,omitempty"`
}

type GameEvent struct {
	EventID   int     `json:"eventId,omitempty"`
	EventName string  `json:"eventName,omitempty"`
	EventTime float64 `json:"eventTime,omitempty"`
}

type allGameDataResponse struct {
	ActivePlayer ActiveGamePlayer `json:"activePlayer"`
	AllPlayers   []GamePlayer     `json:"allPlayers"`
	Events       struct {
		Events []GameEvent `json:"Events"`
	} `json:"events"`
	GameData GameData       `json:"gameData"`
	Arena    map[string]any `json:"arena"`
}

// FetchActiveGame returns a single consistent active-game snapshot. It does
// not attempt any game mutation and returns an error when the game API is not
// available (which is normal while the client is in loading or lobby phases).
func FetchActiveGame(ctx context.Context) (*GameClientData, error) {
	return defaultGameClient.FetchActiveGame(ctx)
}

func (c *GameClient) FetchActiveGame(ctx context.Context) (*GameClientData, error) {
	if c == nil || c.HTTPClient == nil {
		return nil, errors.New("game client is not configured")
	}
	base, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, errors.New("game client base URL is invalid")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/liveclientdata/allgamedata"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("game client request: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGameClientBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read game client response: %w", err)
	}
	if len(body) > maxGameClientBytes {
		return nil, fmt.Errorf("game client response exceeded %d bytes", maxGameClientBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("game client returned HTTP %d", resp.StatusCode)
	}
	var raw allGameDataResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("decode game client response: %w", err)
	}
	return &GameClientData{
		Available:    true,
		UpdatedAt:    time.Now().UTC(),
		GameData:     raw.GameData,
		Arena:        raw.Arena,
		ActivePlayer: &raw.ActivePlayer,
		Players:      raw.AllPlayers,
		Events:       raw.Events.Events,
	}, nil
}
