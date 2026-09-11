package sessionvault

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testProtector struct{}

func (testProtector) seal(plaintext, context []byte) ([]byte, error) {
	result := append([]byte("sealed:"), context...)
	result = append(result, 0)
	for index := len(plaintext) - 1; index >= 0; index-- {
		result = append(result, plaintext[index])
	}
	return result, nil
}

func (testProtector) open(ciphertext, context []byte) ([]byte, error) {
	prefix := append(append([]byte("sealed:"), context...), 0)
	if !bytes.HasPrefix(ciphertext, prefix) {
		return nil, errors.New("wrong context")
	}
	encoded := ciphertext[len(prefix):]
	result := make([]byte, len(encoded))
	for index := range encoded {
		result[index] = encoded[len(encoded)-1-index]
	}
	return result, nil
}

func TestCaptureStatusRestoreAndDelete(t *testing.T) {
	dataDir := t.TempDir()
	vaultDir := t.TempDir()
	original := []byte("opaque-riot-session")
	if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), original, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	vault := &Vault{RiotDataDir: dataDir, VaultDir: vaultDir, protector: testProtector{}, now: func() time.Time { return now }}
	if err := vault.Capture("profile-test", 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	status, err := vault.Status("profile-test")
	if err != nil || !status.ExpiresAt.Equal(now.Add(30*24*time.Hour)) {
		t.Fatalf("status = %+v, error = %v", status, err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), []byte("other-account"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := vault.Restore("profile-test"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dataDir, privateSettingsFile))
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("restored = %q, error = %v", got, err)
	}
	if err := vault.Delete("profile-test"); err != nil {
		t.Fatal(err)
	}
	if _, err := vault.Status("profile-test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("status after delete error = %v", err)
	}
}

func TestExpiredLoginIsNotRestored(t *testing.T) {
	dataDir := t.TempDir()
	vault := &Vault{RiotDataDir: dataDir, VaultDir: t.TempDir(), protector: testProtector{}}
	if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	vault.now = func() time.Time { return now }
	if err := vault.Capture("profile-test", time.Hour); err != nil {
		t.Fatal(err)
	}
	vault.now = func() time.Time { return now.Add(2 * time.Hour) }
	if err := vault.Restore("profile-test"); !errors.Is(err, ErrExpired) {
		t.Fatalf("restore error = %v", err)
	}
}

func TestClearActiveSession(t *testing.T) {
	dataDir := t.TempDir()
	path := filepath.Join(dataDir, privateSettingsFile)
	if err := os.WriteFile(path, []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}
	vault := &Vault{RiotDataDir: dataDir, VaultDir: t.TempDir(), protector: testProtector{}}
	if err := vault.ClearActiveSession(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("session file still exists, error = %v", err)
	}
	if err := vault.ClearActiveSession(); err != nil {
		t.Fatalf("clearing an already-empty session should be idempotent: %v", err)
	}
}

func TestRefreshIfEnrolledKeepsProfilesIsolatedAndRenewsExpiry(t *testing.T) {
	dataDir := t.TempDir()
	vault := &Vault{RiotDataDir: dataDir, VaultDir: t.TempDir(), protector: testProtector{}}
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	vault.now = func() time.Time { return now }

	writeSession := func(value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	writeSession("euw-session-v1")
	if err := vault.Capture("euw", 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	writeSession("eune-session-v1")
	if err := vault.Capture("eune", 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}

	now = now.Add(10 * 24 * time.Hour)
	writeSession("euw-session-v2")
	refreshed, err := vault.RefreshIfEnrolled("euw", 30*24*time.Hour)
	if err != nil || !refreshed {
		t.Fatalf("refresh EUW = %t, %v", refreshed, err)
	}
	status, err := vault.Status("euw")
	if err != nil || !status.ExpiresAt.Equal(now.Add(30*24*time.Hour)) {
		t.Fatalf("refreshed EUW status = %+v, %v", status, err)
	}

	if err := vault.Restore("eune"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dataDir, privateSettingsFile))
	if err != nil || string(got) != "eune-session-v1" {
		t.Fatalf("EUNE restore = %q, %v", got, err)
	}
	if err := vault.Restore("euw"); err != nil {
		t.Fatal(err)
	}
	got, err = os.ReadFile(filepath.Join(dataDir, privateSettingsFile))
	if err != nil || string(got) != "euw-session-v2" {
		t.Fatalf("EUW restore = %q, %v", got, err)
	}

	writeSession("unknown-session")
	refreshed, err = vault.RefreshIfEnrolled("new-profile", 30*24*time.Hour)
	if err != nil || refreshed {
		t.Fatalf("unenrolled refresh = %t, %v", refreshed, err)
	}
	if _, err := vault.Status("new-profile"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unenrolled profile unexpectedly captured: %v", err)
	}
}

func TestCaptureAndRestoreBothSettingsFiles(t *testing.T) {
	dataDir := t.TempDir()
	vault := &Vault{RiotDataDir: dataDir, VaultDir: t.TempDir(), protector: testProtector{}, now: time.Now}

	gamesData := []byte("games-private-settings")
	clientData := []byte("client-private-settings-with-tokens")

	if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), gamesData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, clientPrivateSettingsFile), clientData, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := vault.Capture("profile-dual", 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}

	// Overwrite both with other account
	if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), []byte("other-games"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, clientPrivateSettingsFile), []byte("other-client"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := vault.Restore("profile-dual"); err != nil {
		t.Fatal(err)
	}

	gotGames, err := os.ReadFile(filepath.Join(dataDir, privateSettingsFile))
	if err != nil || !bytes.Equal(gotGames, gamesData) {
		t.Fatalf("restored games = %q, want %q", gotGames, gamesData)
	}
	gotClient, err := os.ReadFile(filepath.Join(dataDir, clientPrivateSettingsFile))
	if err != nil || !bytes.Equal(gotClient, clientData) {
		t.Fatalf("restored client = %q, want %q", gotClient, clientData)
	}

	// Test clear removes both
	if err := vault.ClearActiveSession(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, privateSettingsFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("privateSettingsFile was not removed")
	}
	if _, err := os.Stat(filepath.Join(dataDir, clientPrivateSettingsFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("clientPrivateSettingsFile was not removed")
	}
}

func TestCaptureAndRestoreCompleteRiotRememberedLoginState(t *testing.T) {
	dataDir := t.TempDir()
	clientRoot := filepath.Dir(dataDir)
	configDir := filepath.Join(clientRoot, "Config")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	vault := &Vault{RiotDataDir: dataDir, VaultDir: t.TempDir(), protector: testProtector{}, now: time.Now}

	files := map[string][]byte{
		filepath.Join(dataDir, privateSettingsFile):                   []byte("games-session"),
		filepath.Join(dataDir, clientPrivateSettingsFile):             []byte("client-session"),
		filepath.Join(dataDir, "Cookies", "Cookies"):                  []byte("cookie-db"),
		filepath.Join(dataDir, "Sessions", "account", "session.json"): []byte("session-json"),
		filepath.Join(configDir, clientSettingsFile):                  []byte("client-settings"),
	}
	for path, contents := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := vault.Capture("complete", 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}

	// A different account leaves stale cookie/session state behind. Restore
	// must replace the complete allowlisted set, not only the YAML files.
	if err := os.WriteFile(filepath.Join(dataDir, "Cookies", "stale"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, privateSettingsFile), []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := vault.Restore("complete"); err != nil {
		t.Fatal(err)
	}

	for path, want := range files {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("restored %s = %q, %v; want %q", path, got, err, want)
		}
	}
	if _, err := os.Stat(filepath.Join(dataDir, "Cookies", "stale")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale cookie was not removed, error = %v", err)
	}
}

func TestClearActiveSessionRemovesCompleteRememberedLoginState(t *testing.T) {
	dataDir := t.TempDir()
	clientRoot := filepath.Dir(dataDir)
	configPath := filepath.Join(clientRoot, "Config", clientSettingsFile)
	paths := []string{
		filepath.Join(dataDir, privateSettingsFile),
		filepath.Join(dataDir, clientPrivateSettingsFile),
		filepath.Join(dataDir, "Cookies", "Cookies"),
		filepath.Join(dataDir, "Sessions", "session"),
		configPath,
	}
	for _, path := range paths {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("session"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	vault := &Vault{RiotDataDir: dataDir, VaultDir: t.TempDir(), protector: testProtector{}}
	if err := vault.ClearActiveSession(); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("session path %s still exists, error = %v", path, err)
		}
	}
}

func TestRestoreMigratesLegacyTwoFileVault(t *testing.T) {
	dataDir := t.TempDir()
	vaultDir := t.TempDir()
	vault := &Vault{RiotDataDir: dataDir, VaultDir: vaultDir, protector: testProtector{}, now: time.Now}
	now := time.Now().UTC()
	legacy, err := json.Marshal(payload{
		Version:    1,
		CapturedAt: now,
		ExpiresAt:  now.Add(time.Hour),
		Data:       []byte("legacy-games"),
		ClientData: []byte("legacy-client"),
	})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := vault.protector.seal(legacy, []byte("legacy"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vault.path("legacy"), sealed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := vault.Restore("legacy"); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		filepath.Join(dataDir, privateSettingsFile):       "legacy-games",
		filepath.Join(dataDir, clientPrivateSettingsFile): "legacy-client",
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("legacy restore %s = %q, %v; want %q", path, got, err, want)
		}
	}
}
