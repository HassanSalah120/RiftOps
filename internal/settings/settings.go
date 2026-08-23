package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
	"github.com/HassanSalah120/RiftOps/internal/model"
)

const CurrentVersion = 2

type StartupStatus string

const StartupLast StartupStatus = "last"

type Settings struct {
	Version           int             `json:"version"`
	Enabled           bool            `json:"enabled"`
	Status            model.Status    `json:"status"`
	StartupStatus     StartupStatus   `json:"startupStatus"`
	DefaultGame       model.Game      `json:"defaultGame"`
	ConnectToMUC      bool            `json:"connectToMUC"`
	CheckUpdates      bool            `json:"checkUpdates"`
	RiotClientPath    string          `json:"riotClientPath,omitempty"`
	PromptedUpdate    string          `json:"promptedUpdate,omitempty"`
	IntroductionShown bool            `json:"introductionShown"`
	PhoneAccess       bool            `json:"phoneAccess"`
	ActiveProfileID   string          `json:"activeProfileId"`
	Profiles          []LaunchProfile `json:"profiles"`
}

// Clone returns a fully independent settings snapshot. Settings is otherwise
// cheap to copy, but launch profiles contain slices and maps whose backing
// storage must not be shared with a concurrent persistence operation.
func (s Settings) Clone() Settings {
	cloned := s
	cloned.Profiles = make([]LaunchProfile, len(s.Profiles))
	for index, profile := range s.Profiles {
		clonedProfile := profile
		clonedProfile.RiotClientArgs = append([]string(nil), profile.RiotClientArgs...)
		clonedProfile.GameArgs = append([]string(nil), profile.GameArgs...)
		if profile.GameStatuses != nil {
			clonedProfile.GameStatuses = make(map[model.Game]model.Status, len(profile.GameStatuses))
			for game, status := range profile.GameStatuses {
				clonedProfile.GameStatuses[game] = status
			}
		}
		cloned.Profiles[index] = clonedProfile
	}
	return cloned
}

func Default() Settings {
	result := Settings{
		Version: CurrentVersion, Enabled: true, Status: model.StatusOffline,
		StartupStatus: StartupLast, DefaultGame: model.GamePrompt,
		ConnectToMUC: true, CheckUpdates: true, ActiveProfileID: DefaultProfileID,
	}
	result.Profiles = []LaunchProfile{profileFromSettings(result, DefaultProfileID, "Default")}
	return result
}

func (s *Settings) Validate() error {
	if s.Version != CurrentVersion {
		return fmt.Errorf("unsupported settings version %d", s.Version)
	}
	if !s.Status.Valid() {
		return fmt.Errorf("invalid status %q", s.Status)
	}
	if s.StartupStatus != StartupLast {
		if _, err := model.ParseStatus(string(s.StartupStatus)); err != nil {
			return fmt.Errorf("invalid startup status %q", s.StartupStatus)
		}
	}
	if _, err := model.ParseGame(string(s.DefaultGame)); err != nil {
		return err
	}
	if len(s.RiotClientPath) > 4096 || strings.ContainsRune(s.RiotClientPath, '\x00') {
		return fmt.Errorf("Riot Client location is invalid")
	}
	if len(s.Profiles) == 0 {
		return fmt.Errorf("at least one launch profile is required")
	}
	seen := make(map[string]struct{}, len(s.Profiles))
	activeFound := false
	for _, profile := range s.Profiles {
		if err := profile.Validate(); err != nil {
			return fmt.Errorf("profile %q: %w", profile.Name, err)
		}
		if _, exists := seen[profile.ID]; exists {
			return fmt.Errorf("duplicate launch profile ID %q", profile.ID)
		}
		seen[profile.ID] = struct{}{}
		activeFound = activeFound || profile.ID == s.ActiveProfileID
	}
	if !activeFound {
		return fmt.Errorf("active launch profile %q was not found", s.ActiveProfileID)
	}
	return nil
}

type Store struct{ Path string }

func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "RiftOps", "settings.json"), nil
}

func (s Store) Load() (Settings, error) {
	defaults := Default()
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		if isDefaultStorePath(s.Path) {
			if migrated, ok := migratePriorJSON(defaults); ok {
				if saveErr := s.Save(migrated); saveErr != nil {
					return Settings{}, saveErr
				}
				return migrated, nil
			}
			if migrated, ok := migrateLegacy(defaults); ok {
				if saveErr := s.Save(migrated); saveErr != nil {
					return Settings{}, saveErr
				}
				return migrated, nil
			}
		}
		return defaults, nil
	}
	if err != nil {
		return Settings{}, fmt.Errorf("read settings: %w", err)
	}
	result, err := decodeSettings(data, defaults)
	if err != nil {
		return Settings{}, err
	}
	if err := result.Validate(); err != nil {
		return Settings{}, err
	}
	return result, nil
}

func decodeSettings(data []byte, defaults Settings) (Settings, error) {
	result := defaults
	if err := json.Unmarshal(data, &result); err != nil {
		return Settings{}, fmt.Errorf("decode settings: %w", err)
	}
	if result.Version == 1 {
		result.Version = CurrentVersion
		result.ActiveProfileID = DefaultProfileID
		result.Profiles = []LaunchProfile{profileFromSettings(result, DefaultProfileID, "Default")}
	}
	if result.Version != CurrentVersion {
		return Settings{}, fmt.Errorf("unsupported settings version %d", result.Version)
	}
	return result, nil
}

func migratePriorJSON(defaults Settings) (Settings, bool) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return Settings{}, false
	}
	return loadPriorJSON(filepath.Join(dir, "Deceive", "settings.json"), defaults)
}

func loadPriorJSON(path string, defaults Settings) (Settings, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Settings{}, false
	}
	result, err := decodeSettings(data, defaults)
	if err != nil {
		return Settings{}, false
	}
	if err := result.Validate(); err != nil {
		return Settings{}, false
	}
	return result, true
}

func isDefaultStorePath(path string) bool {
	defaultPath, err := DefaultPath()
	return err == nil && filepath.Clean(path) == filepath.Clean(defaultPath)
}

func (s Store) Save(value Settings) error {
	value = value.Clone()
	value.syncActiveProfile()
	if err := value.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create settings directory: %w", err)
	}
	temporary, err := os.CreateTemp(dir, "settings-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := atomicfile.Replace(temporaryName, s.Path); err != nil {
		return fmt.Errorf("replace settings: %w", err)
	}
	return nil
}

func migrateLegacy(defaults Settings) (Settings, bool) {
	if runtime.GOOS != "windows" {
		return Settings{}, false
	}
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return Settings{}, false
	}
	return MigrateLegacyDirectory(filepath.Join(appData, "Deceive"), defaults)
}

func MigrateLegacyDirectory(directory string, defaults Settings) (Settings, bool) {
	if info, err := os.Stat(directory); err != nil || !info.IsDir() {
		return Settings{}, false
	}
	result := defaults
	read := func(name string) string {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(data))
	}
	if status, err := model.ParseStatus(read("status")); err == nil {
		result.Status = status
	}
	if game, err := model.ParseGame(read("launchGame")); err == nil {
		result.DefaultGame = game
	}
	startup := strings.ToLower(read("startupStatus"))
	if startup == "last" {
		result.StartupStatus = StartupLast
	} else if parsed, err := model.ParseStatus(startup); err == nil {
		result.StartupStatus = StartupStatus(parsed)
	}
	if _, err := os.Stat(filepath.Join(directory, "introductionShown")); err == nil {
		result.IntroductionShown = true
	}
	result.PromptedUpdate = read("updateVersionPrompted")
	result.syncActiveProfile()
	return result, true
}
