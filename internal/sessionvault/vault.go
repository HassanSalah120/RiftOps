package sessionvault

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
)

const (
	privateSettingsFile = "RiotGamesPrivateSettings.yaml"
	maxSessionBytes     = 2 << 20
)

var (
	ErrNotFound = errors.New("saved Riot login was not found")
	ErrExpired  = errors.New("saved Riot login has expired")
	validID     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
)

type protector interface {
	seal(plaintext, context []byte) ([]byte, error)
	open(ciphertext, context []byte) ([]byte, error)
}

type Vault struct {
	RiotDataDir string
	VaultDir    string
	protector   protector
	now         func() time.Time
}

type Status struct {
	CapturedAt time.Time
	ExpiresAt  time.Time
}

type payload struct {
	Version    int       `json:"version"`
	CapturedAt time.Time `json:"capturedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Data       []byte    `json:"data"`
}

func Default(vaultDir string) (*Vault, error) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		return nil, fmt.Errorf("encrypted Riot login switching is not implemented on %s", runtime.GOOS)
	}
	dataDir, err := defaultRiotDataDir()
	if err != nil {
		return nil, err
	}
	return &Vault{RiotDataDir: dataDir, VaultDir: vaultDir, protector: platformProtector{}, now: time.Now}, nil
}

func (v *Vault) Capture(profileID string, lifetime time.Duration) error {
	if err := validateProfileID(profileID); err != nil {
		return err
	}
	if lifetime <= 0 || lifetime > 90*24*time.Hour {
		return fmt.Errorf("saved login lifetime must be between 1 minute and 90 days")
	}
	path := filepath.Join(v.RiotDataDir, privateSettingsFile)
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("Riot remembered-login state is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maxSessionBytes {
		return errors.New("Riot remembered-login state was not a safe regular file")
	}
	data, err := readStableFile(path)
	if err != nil {
		return fmt.Errorf("read Riot remembered-login state: %w", err)
	}
	defer clearBytes(data)
	now := v.now().UTC()
	encoded, err := json.Marshal(payload{Version: 1, CapturedAt: now, ExpiresAt: now.Add(lifetime), Data: data})
	if err != nil {
		return err
	}
	defer clearBytes(encoded)
	sealed, err := v.protector.seal(encoded, []byte(profileID))
	if err != nil {
		return fmt.Errorf("protect saved Riot login with the operating system: %w", err)
	}
	defer clearBytes(sealed)
	return writePrivateFile(v.path(profileID), sealed)
}

// RefreshIfEnrolled updates an existing profile session from Riot's current
// remembered-login state. A profile must be explicitly captured once before
// automatic refresh is allowed; this prevents an unrelated active Riot login
// from being silently assigned to a newly-created profile.
func (v *Vault) RefreshIfEnrolled(profileID string, lifetime time.Duration) (bool, error) {
	value, err := v.load(profileID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	clearBytes(value.Data)
	if err := v.Capture(profileID, lifetime); err != nil {
		return true, err
	}
	return true, nil
}

func readStableFile(path string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		before, err := file.Stat()
		if err != nil {
			file.Close()
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxSessionBytes+1))
		after, statErr := file.Stat()
		closeErr := file.Close()
		if readErr == nil && len(data) <= maxSessionBytes && statErr == nil && closeErr == nil && before.Size() == after.Size() && before.ModTime() == after.ModTime() {
			return data, nil
		}
		clearBytes(data)
		lastErr = errors.New("Riot remembered-login state changed while it was being captured")
		time.Sleep(100 * time.Millisecond)
	}
	return nil, lastErr
}

func (v *Vault) Restore(profileID string) error {
	value, err := v.load(profileID)
	if err != nil {
		return err
	}
	defer clearBytes(value.Data)
	if v.now().After(value.ExpiresAt) {
		return ErrExpired
	}
	if len(value.Data) == 0 || len(value.Data) > maxSessionBytes {
		return errors.New("saved Riot login payload was invalid")
	}
	return writePrivateFile(filepath.Join(v.RiotDataDir, privateSettingsFile), value.Data)
}

// ClearActiveSession removes the remembered-login file so Riot shows its
// normal sign-in screen. It is used only for an explicit profile switch when
// the selected profile has no usable saved session.
func (v *Vault) ClearActiveSession() error {
	path := filepath.Join(v.RiotDataDir, privateSettingsFile)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Riot remembered-login state was not a safe regular file")
	}
	return os.Remove(path)
}

func (v *Vault) Status(profileID string) (Status, error) {
	value, err := v.load(profileID)
	if err != nil {
		return Status{}, err
	}
	defer clearBytes(value.Data)
	if v.now().After(value.ExpiresAt) {
		return Status{CapturedAt: value.CapturedAt, ExpiresAt: value.ExpiresAt}, ErrExpired
	}
	return Status{CapturedAt: value.CapturedAt, ExpiresAt: value.ExpiresAt}, nil
}

func (v *Vault) Delete(profileID string) error {
	if err := validateProfileID(profileID); err != nil {
		return err
	}
	err := os.Remove(v.path(profileID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (v *Vault) load(profileID string) (payload, error) {
	if err := validateProfileID(profileID); err != nil {
		return payload{}, err
	}
	sealed, err := os.ReadFile(v.path(profileID))
	if errors.Is(err, os.ErrNotExist) {
		return payload{}, ErrNotFound
	}
	if err != nil {
		return payload{}, err
	}
	defer clearBytes(sealed)
	decoded, err := v.protector.open(sealed, []byte(profileID))
	if err != nil {
		return payload{}, fmt.Errorf("unlock saved Riot login: %w", err)
	}
	defer clearBytes(decoded)
	var value payload
	if err := json.Unmarshal(decoded, &value); err != nil || value.Version != 1 {
		return payload{}, errors.New("saved Riot login format was invalid")
	}
	return value, nil
}

func (v *Vault) path(profileID string) string { return filepath.Join(v.VaultDir, profileID+".vault") }

func defaultRiotDataDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		root := os.Getenv("LOCALAPPDATA")
		if root == "" {
			return "", errors.New("LOCALAPPDATA is unavailable")
		}
		return filepath.Join(root, "Riot Games", "Riot Client", "Data"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "Riot Games", "Riot Client", "Data"), nil
	default:
		return "", fmt.Errorf("saved Riot logins are unsupported on %s", runtime.GOOS)
	}
}

func validateProfileID(profileID string) error {
	if !validID.MatchString(profileID) {
		return errors.New("profile ID is invalid")
	}
	return nil
}

func writePrivateFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".riftops-session-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
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
	return atomicfile.Replace(name, path)
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
