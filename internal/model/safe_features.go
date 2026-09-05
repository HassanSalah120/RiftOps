package model

import (
	"encoding/json"
	"time"
)

// Safe feature contracts shared by desktop handlers and future clients. All
// identifiers are opaque and accountKey is a SHA-256-derived value, never a
// raw PUUID.
type SocialSnapshot struct {
	Friends        json.RawMessage `json:"friends"`
	FriendRequests json.RawMessage `json:"friendRequests"`
	FriendGroups   json.RawMessage `json:"friendGroups"`
	Lobby          json.RawMessage `json:"lobby,omitempty"`
	Warnings       []string        `json:"warnings,omitempty"`
	FetchedAt      time.Time       `json:"fetchedAt"`
}

type FriendRequest struct {
	ID        string `json:"id"`
	Direction string `json:"direction,omitempty"`
	State     string `json:"state,omitempty"`
}
type FriendGroup struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	FriendIDs []string `json:"friendIds,omitempty"`
}
type ProfilePreset struct {
	ID                    string `json:"id"`
	Name                  string `json:"name"`
	AccountKey            string `json:"accountKey"`
	IconID                int    `json:"iconId,omitempty"`
	BackgroundSkinID      int    `json:"backgroundSkinId,omitempty"`
	TitleID               int    `json:"titleId,omitempty"`
	BannerID              int    `json:"bannerId,omitempty"`
	BannerAccent          string `json:"bannerAccent,omitempty"`
	TokenIDs              []int  `json:"tokenIds,omitempty"`
	PreferredBannerType   string `json:"preferredBannerType,omitempty"`
	PreferredCrestType    string `json:"preferredCrestType,omitempty"`
	SelectedPrestigeCrest int    `json:"selectedPrestigeCrest,omitempty"`
	StatusMessage         string `json:"statusMessage,omitempty"`
}
type ProfilePresetPreview struct {
	ID        string          `json:"previewId"`
	Current   json.RawMessage `json:"current"`
	Proposed  ProfilePreset   `json:"proposed"`
	ExpiresAt time.Time       `json:"expiresAt"`
}
type PreparationPreset struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	AccountKey         string `json:"accountKey"`
	ChampionID         int    `json:"championId,omitempty"`
	QueueFamily        string `json:"queueFamily,omitempty"`
	Role               string `json:"role,omitempty"`
	RunePageID         int    `json:"runePageId,omitempty"`
	FallbackRunePageID int    `json:"fallbackRunePageId,omitempty"`
	Spell1ID           int    `json:"spell1Id,omitempty"`
	Spell2ID           int    `json:"spell2Id,omitempty"`
	ItemIDs            []int  `json:"itemIds,omitempty"`
	ItemSetID          string `json:"itemSetId,omitempty"`
}
type LobbyPreset struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	QueueID    int    `json:"queueId"`
	QueueName  string `json:"queueName,omitempty"`
	FirstRole  string `json:"firstRole,omitempty"`
	SecondRole string `json:"secondRole,omitempty"`
	MapID      int    `json:"mapId,omitempty"`
	GameMode   string `json:"gameMode,omitempty"`
}
type ReplayStatus struct {
	GameID   int64   `json:"gameId"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress,omitempty"`
	Error    string  `json:"error,omitempty"`
}
type ClientSettingsBackup struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	AccountKey string    `json:"accountKey"`
	CreatedAt  time.Time `json:"createdAt"`
}
type SettingsRestorePreview struct {
	Backup              ClientSettingsBackup `json:"backup"`
	Current             json.RawMessage      `json:"current"`
	RestoreConfirmation string               `json:"restoreConfirmation"`
}
type BatchOperation struct {
	ID           string    `json:"id"`
	Kind         string    `json:"kind"`
	TargetIDs    []string  `json:"targetIds"`
	Confirmation string    `json:"confirmation"`
	ExpiresAt    time.Time `json:"expiresAt"`
}
type BatchItemResult struct {
	TargetID string `json:"targetId"`
	Label    string `json:"label,omitempty"`
	Status   string `json:"status"`
	Detail   string `json:"detail,omitempty"`
}
type BatchReceipt struct {
	ID          string            `json:"id"`
	Kind        string            `json:"kind"`
	CreatedAt   time.Time         `json:"createdAt"`
	CompletedAt *time.Time        `json:"completedAt,omitempty"`
	Total       int               `json:"total"`
	Succeeded   int               `json:"succeeded"`
	Failed      int               `json:"failed"`
	Cancelled   bool              `json:"cancelled"`
	Items       []BatchItemResult `json:"items"`
}
type CapabilityStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
	Patch  string `json:"patch,omitempty"`
}
