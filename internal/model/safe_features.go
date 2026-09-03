package model

import "time"

// Safe feature contracts shared by desktop handlers and future clients. All
// identifiers are opaque and accountKey is a SHA-256-derived value, never a
// raw PUUID.
type SocialSnapshot struct {
	Friends        any       `json:"friends"`
	FriendRequests any       `json:"friendRequests"`
	FriendGroups   any       `json:"friendGroups"`
	Lobby          any       `json:"lobby,omitempty"`
	FetchedAt      time.Time `json:"fetchedAt"`
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
	ID         string `json:"id"`
	Name       string `json:"name"`
	AccountKey string `json:"accountKey"`
}
type ProfilePresetPreview struct {
	Current   any       `json:"current"`
	Proposed  any       `json:"proposed"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type PreparationPreset struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	AccountKey string `json:"accountKey"`
}
type LobbyPreset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	QueueID int    `json:"queueId"`
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
	Current             any                  `json:"current"`
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
	Status   string `json:"status"`
	Detail   string `json:"detail,omitempty"`
}
type BatchReceipt struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	CreatedAt time.Time         `json:"createdAt"`
	Total     int               `json:"total"`
	Succeeded int               `json:"succeeded"`
	Failed    int               `json:"failed"`
	Items     []BatchItemResult `json:"items"`
}
type CapabilityStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
	Patch  string `json:"patch,omitempty"`
}
