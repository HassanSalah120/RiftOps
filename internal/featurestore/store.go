// Package featurestore persists RiftOps' non-secret feature data.
//
// The store deliberately does not contain Riot credentials, LCU tokens, or
// raw PUUIDs. Account-scoped records use a one-way account key derived from
// the current PUUID and are written atomically with private file permissions.
package featurestore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
)

const CurrentVersion = 1

type ProfilePreset struct {
	ID                    string `json:"id"`
	Name                  string `json:"name"`
	AccountKey            string `json:"accountKey"`
	IconID                int    `json:"iconId,omitempty"`
	BackgroundSkinID      int    `json:"backgroundSkinId,omitempty"`
	TitleID               int    `json:"titleId,omitempty"`
	BannerID              int    `json:"bannerId,omitempty"` // retained for version-1 store compatibility
	BannerAccent          string `json:"bannerAccent,omitempty"`
	TokenIDs              []int  `json:"tokenIds,omitempty"`
	PreferredBannerType   string `json:"preferredBannerType,omitempty"`
	PreferredCrestType    string `json:"preferredCrestType,omitempty"`
	SelectedPrestigeCrest int    `json:"selectedPrestigeCrest,omitempty"`
	StatusMessage         string `json:"statusMessage,omitempty"`
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

type ClientSettingsBackup struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	AccountKey string          `json:"accountKey"`
	CreatedAt  time.Time       `json:"createdAt"`
	Payload    json.RawMessage `json:"payload"`
}

// ItemSetSnapshot is a redacted local recovery point captured immediately
// before RiftOps writes a managed item set. It never contains credentials.
type ItemSetSnapshot struct {
	ID         string          `json:"id"`
	AccountKey string          `json:"accountKey"`
	CreatedAt  time.Time       `json:"createdAt"`
	Payload    json.RawMessage `json:"payload"`
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

type Data struct {
	Version            int                               `json:"version"`
	ProfilePresets     map[string][]ProfilePreset        `json:"profilePresets"`
	PreparationPresets map[string][]PreparationPreset    `json:"preparationPresets"`
	LobbyPresets       []LobbyPreset                     `json:"lobbyPresets"`
	SettingsBackups    map[string][]ClientSettingsBackup `json:"settingsBackups"`
	ItemSetSnapshots   map[string][]ItemSetSnapshot      `json:"itemSetSnapshots"`
	BatchReceipts      []BatchReceipt                    `json:"batchReceipts"`
}

func defaultData() Data {
	return Data{
		Version:            CurrentVersion,
		ProfilePresets:     make(map[string][]ProfilePreset),
		PreparationPresets: make(map[string][]PreparationPreset),
		SettingsBackups:    make(map[string][]ClientSettingsBackup),
		ItemSetSnapshots:   make(map[string][]ItemSetSnapshot),
		LobbyPresets:       []LobbyPreset{},
		BatchReceipts:      []BatchReceipt{},
	}
}

func AccountKey(puuid string) string {
	hash := sha256.Sum256([]byte(strings.TrimSpace(puuid)))
	return hex.EncodeToString(hash[:])
}

type Store struct {
	Path string
	mu   sync.Mutex
	data Data
}

func New(path string) (*Store, error) {
	store := &Store{Path: path, data: defaultData()}
	if err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read feature store: %w", err)
	}
	var decoded Data
	if err := json.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("decode feature store: %w", err)
	}
	if decoded.Version != CurrentVersion {
		return fmt.Errorf("unsupported feature store version %d", decoded.Version)
	}
	if decoded.ProfilePresets == nil {
		decoded.ProfilePresets = make(map[string][]ProfilePreset)
	}
	if decoded.PreparationPresets == nil {
		decoded.PreparationPresets = make(map[string][]PreparationPreset)
	}
	if decoded.SettingsBackups == nil {
		decoded.SettingsBackups = make(map[string][]ClientSettingsBackup)
	}
	if decoded.ItemSetSnapshots == nil {
		decoded.ItemSetSnapshots = make(map[string][]ItemSetSnapshot)
	}
	if decoded.LobbyPresets == nil {
		decoded.LobbyPresets = []LobbyPreset{}
	}
	if decoded.BatchReceipts == nil {
		decoded.BatchReceipts = []BatchReceipt{}
	}
	s.data = decoded
	return nil
}

func (s *Store) Snapshot() Data {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneData(s.data)
}

func (s *Store) Save(data Data) error {
	data = cloneData(data)
	data.Version = CurrentVersion
	if data.ProfilePresets == nil {
		data.ProfilePresets = make(map[string][]ProfilePreset)
	}
	if data.PreparationPresets == nil {
		data.PreparationPresets = make(map[string][]PreparationPreset)
	}
	if data.SettingsBackups == nil {
		data.SettingsBackups = make(map[string][]ClientSettingsBackup)
	}
	if data.ItemSetSnapshots == nil {
		data.ItemSetSnapshots = make(map[string][]ItemSetSnapshot)
	}
	encoded, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("encode feature store: %w", err)
	}
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create feature store directory: %w", err)
	}
	_ = os.Chmod(dir, 0o700)
	temporary, err := os.CreateTemp(dir, "features-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := atomicfile.Replace(temporaryName, s.Path); err != nil {
		return fmt.Errorf("replace feature store: %w", err)
	}
	s.mu.Lock()
	s.data = data
	s.mu.Unlock()
	return nil
}

func (s *Store) Update(fn func(*Data) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneData(s.data)
	if err := fn(&next); err != nil {
		return err
	}
	next.Version = CurrentVersion
	encoded, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, "features-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := atomicfile.Replace(temporaryName, s.Path); err != nil {
		return err
	}
	s.data = next
	return nil
}

func cloneData(input Data) Data {
	encoded, _ := json.Marshal(input)
	var output Data
	if err := json.Unmarshal(encoded, &output); err != nil {
		return defaultData()
	}
	return output
}
