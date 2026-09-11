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
	"sort"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
)

const (
	privateSettingsFile       = "RiotGamesPrivateSettings.yaml"
	clientPrivateSettingsFile = "RiotClientPrivateSettings.yaml"
	clientSettingsFile        = "RiotClientSettings.yaml"
	maxSessionBytes           = 2 << 20
	maxSessionFiles           = 128
	maxSessionBundleBytes     = 16 << 20
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
	ClientData []byte    `json:"clientData,omitempty"`
	// Files is the current format. Data and ClientData remain for vaults
	// written by older RiftOps versions and are migrated on restore.
	Files map[string][]byte `json:"files,omitempty"`
}

type sessionPath struct {
	Key       string
	Path      string
	Directory bool
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

	files, err := v.captureFiles()
	if err != nil {
		return err
	}
	defer clearFileMap(files)

	now := v.now().UTC()
	encoded, err := json.Marshal(payload{
		Version:    1,
		CapturedAt: now,
		ExpiresAt:  now.Add(lifetime),
		Files:      files,
	})
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

// sessionPaths is deliberately allowlisted. Riot stores other data beside
// these paths, but only these paths participate in its remembered-login
// mechanism and may be copied into a profile vault.
func (v *Vault) sessionPaths() []sessionPath {
	clientRoot := filepath.Dir(v.RiotDataDir)
	return []sessionPath{
		{Key: "Data/" + privateSettingsFile, Path: filepath.Join(v.RiotDataDir, privateSettingsFile)},
		{Key: "Data/" + clientPrivateSettingsFile, Path: filepath.Join(v.RiotDataDir, clientPrivateSettingsFile)},
		{Key: "Data/Cookies", Path: filepath.Join(v.RiotDataDir, "Cookies"), Directory: true},
		{Key: "Data/Sessions", Path: filepath.Join(v.RiotDataDir, "Sessions"), Directory: true},
		{Key: "Config/" + clientSettingsFile, Path: filepath.Join(clientRoot, "Config", clientSettingsFile)},
	}
}

func (v *Vault) captureFiles() (map[string][]byte, error) {
	files := make(map[string][]byte)
	var total int64
	for _, spec := range v.sessionPaths() {
		info, err := os.Lstat(spec.Path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("inspect Riot remembered-login state: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("Riot remembered-login state contains an unsafe symlink: %s", spec.Key)
		}
		if spec.Directory {
			if !info.IsDir() {
				return nil, fmt.Errorf("Riot remembered-login state path is not a directory: %s", spec.Key)
			}
			if err := v.captureDirectory(spec, files, &total); err != nil {
				return nil, err
			}
			continue
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxSessionBytes {
			return nil, fmt.Errorf("Riot remembered-login state was not a safe regular file: %s", spec.Key)
		}
		data, err := readStableFile(spec.Path)
		if err != nil {
			return nil, fmt.Errorf("read Riot remembered-login state: %w", err)
		}
		total += int64(len(data))
		if total > maxSessionBundleBytes {
			clearBytes(data)
			return nil, errors.New("Riot remembered-login state is larger than the safe profile limit")
		}
		files[spec.Key] = data
	}
	if len(files) == 0 {
		return nil, errors.New("Riot remembered-login state is unavailable")
	}
	return files, nil
}

func (v *Vault) captureDirectory(spec sessionPath, files map[string][]byte, total *int64) error {
	err := filepath.WalkDir(spec.Path, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("Riot remembered-login state contains an unsafe symlink: %s", spec.Key)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxSessionBytes {
			return fmt.Errorf("Riot remembered-login state contains an unsafe file: %s", spec.Key)
		}
		if len(files) >= maxSessionFiles {
			return errors.New("Riot remembered-login state contains too many files")
		}
		data, err := readStableFile(path)
		if err != nil {
			return fmt.Errorf("read Riot remembered-login state: %w", err)
		}
		*total += int64(len(data))
		if *total > maxSessionBundleBytes {
			clearBytes(data)
			return errors.New("Riot remembered-login state is larger than the safe profile limit")
		}
		relative, err := filepath.Rel(spec.Path, path)
		if err != nil {
			clearBytes(data)
			return err
		}
		files[spec.Key+"/"+filepath.ToSlash(relative)] = data
		return nil
	})
	if err != nil {
		return fmt.Errorf("read Riot remembered-login state: %w", err)
	}
	return nil
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
	clearBytes(value.ClientData)
	clearFileMap(value.Files)
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
	defer clearBytes(value.ClientData)
	defer clearFileMap(value.Files)
	if v.now().After(value.ExpiresAt) {
		return ErrExpired
	}
	files := value.Files
	if len(files) == 0 {
		files = make(map[string][]byte)
		if len(value.Data) > 0 {
			files["Data/"+privateSettingsFile] = value.Data
		}
		if len(value.ClientData) > 0 {
			files["Data/"+clientPrivateSettingsFile] = value.ClientData
		}
	}
	if err := validateSnapshotFiles(files); err != nil {
		return err
	}
	if len(files) == 0 {
		return errors.New("saved Riot login payload was invalid")
	}
	targets := make(map[string]string, len(files))
	for key := range files {
		path, err := v.pathForKey(key)
		if err != nil {
			return err
		}
		targets[key] = path
	}
	if err := v.clearManagedSession(); err != nil {
		return err
	}
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := writePrivateFile(targets[key], files[key]); err != nil {
			return err
		}
	}
	return nil
}

// ClearActiveSession removes all remembered-login and session files so Riot
// shows its normal, fresh sign-in screen.
func (v *Vault) ClearActiveSession() error {
	return v.clearManagedSession()
}

func (v *Vault) clearManagedSession() error {
	for _, spec := range v.sessionPaths() {
		for _, path := range []string{spec.Path, spec.Path + ".backup"} {
			if err := removeSafePath(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func removeSafePath(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode().IsRegular() {
		return os.Remove(path)
	}
	if info.IsDir() {
		return os.RemoveAll(path)
	}
	return errors.New("Riot remembered-login state contains an unsupported file type")
}

func (v *Vault) pathForKey(key string) (string, error) {
	for _, spec := range v.sessionPaths() {
		if key == spec.Key {
			if spec.Directory {
				return "", errors.New("saved Riot login payload contains a directory entry")
			}
			return spec.Path, nil
		}
		prefix := spec.Key + "/"
		if spec.Directory && strings.HasPrefix(key, prefix) {
			relative := strings.TrimPrefix(key, prefix)
			if relative == "" || filepath.IsAbs(relative) || strings.Contains(relative, "..") {
				return "", errors.New("saved Riot login payload path was invalid")
			}
			return filepath.Join(spec.Path, filepath.FromSlash(relative)), nil
		}
	}
	return "", errors.New("saved Riot login payload contains an unsupported path")
}

func validateSnapshotFiles(files map[string][]byte) error {
	if len(files) > maxSessionFiles {
		return errors.New("saved Riot login payload contains too many files")
	}
	var total int64
	for key, data := range files {
		if len(data) == 0 || len(data) > maxSessionBytes {
			return fmt.Errorf("saved Riot login payload contains an invalid file: %s", key)
		}
		total += int64(len(data))
		if total > maxSessionBundleBytes {
			return errors.New("saved Riot login payload is larger than the safe profile limit")
		}
	}
	return nil
}

func (v *Vault) Status(profileID string) (Status, error) {
	value, err := v.load(profileID)
	if err != nil {
		return Status{}, err
	}
	defer clearBytes(value.Data)
	defer clearBytes(value.ClientData)
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

func clearFileMap(files map[string][]byte) {
	for _, value := range files {
		clearBytes(value)
	}
}
