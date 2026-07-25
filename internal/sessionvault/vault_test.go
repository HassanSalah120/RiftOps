package sessionvault

import (
	"bytes"
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
