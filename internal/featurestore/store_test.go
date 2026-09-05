package featurestore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAccountKeyIsStableAndOneWayShaped(t *testing.T) {
	first := AccountKey("puuid-example")
	if first == "" || len(first) != 64 {
		t.Fatalf("unexpected account key %q", first)
	}
	if first != AccountKey("  puuid-example ") {
		t.Fatal("account key should ignore surrounding whitespace")
	}
	if first == "puuid-example" {
		t.Fatal("account key must not contain the raw PUUID")
	}
}

func TestStoreRoundTripAndAtomicPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "features.json")
	store, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	account := AccountKey("account-a")
	if err := store.Update(func(data *Data) error {
		data.ProfilePresets[account] = []ProfilePreset{{ID: "p1", Name: "Ranked", AccountKey: account, IconID: 123}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	loaded, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	got := loaded.Snapshot()
	if len(got.ProfilePresets[account]) != 1 || got.ProfilePresets[account][0].IconID != 123 {
		t.Fatalf("round-trip lost preset: %+v", got.ProfilePresets)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("feature store is accessible by other users: %o", info.Mode().Perm())
	}
	var decoded Data
	if err := json.Unmarshal(mustRead(t, path), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Version != CurrentVersion {
		t.Fatalf("version = %d, want %d", decoded.Version, CurrentVersion)
	}
}

func TestStoreRejectsUnknownVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "features.json")
	if err := os.WriteFile(path, []byte(`{"version":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(path); err == nil {
		t.Fatal("expected unknown version to be rejected")
	}
}

func TestFailedUpdateLeavesLastAtomicSnapshotIntact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "features.json")
	store, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Update(func(data *Data) error {
		data.LobbyPresets = []LobbyPreset{{ID: "safe", Name: "Existing", QueueID: 420}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before := string(mustRead(t, path))
	if err := store.Update(func(data *Data) error {
		data.LobbyPresets = nil
		return errors.New("stop before write")
	}); err == nil {
		t.Fatal("failed update unexpectedly succeeded")
	}
	if after := string(mustRead(t, path)); after != before {
		t.Fatal("failed update changed the last good atomic snapshot")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
