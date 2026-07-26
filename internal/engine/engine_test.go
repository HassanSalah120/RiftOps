package engine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

func newTestEngine(t *testing.T) (*Engine, settings.Store) {
	t.Helper()
	store := settings.Store{Path: filepath.Join(t.TempDir(), "settings.json")}
	backend, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	return backend, store
}

func TestFailPreservesDisabledState(t *testing.T) {
	backend, _ := newTestEngine(t)
	if err := backend.SetEnabled(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	want := errors.New("preflight failed")
	if got := backend.fail(model.GameLeague, model.StatusOffline, want); !errors.Is(got, want) {
		t.Fatalf("fail() = %v, want %v", got, want)
	}
	if snapshot := backend.Snapshot(); snapshot.Enabled {
		t.Fatal("error snapshot re-enabled presence masking")
	}
}

func TestInvalidGameDoesNotLeaveEngineRunning(t *testing.T) {
	backend, _ := newTestEngine(t)
	for range 2 {
		err := backend.Run(context.Background(), RunOptions{Game: model.GamePrompt})
		if err == nil || err.Error() != "select a game before launching" {
			t.Fatalf("Run() error = %v", err)
		}
	}
}

func TestConcurrentPreferenceWritesPersistLatestState(t *testing.T) {
	backend, store := newTestEngine(t)
	var group sync.WaitGroup
	for index := range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			if index%2 == 0 {
				_ = backend.SetStatus(context.Background(), model.StatusMobile)
				return
			}
			_ = backend.SetEnabled(context.Background(), index%3 == 0)
		}()
	}
	group.Wait()

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	current := backend.Settings()
	if persisted.Status != current.Status || persisted.Enabled != current.Enabled {
		t.Fatalf("persisted status = %s/%t, current = %s/%t", persisted.Status, persisted.Enabled, current.Status, current.Enabled)
	}
}

func TestAllowMultipleClientArgument(t *testing.T) {
	if !hasAllowMultipleClients([]string{"--foo", "--allow-multiple-clients"}) {
		t.Fatal("expected allow-multiple-clients to be detected")
	}
	if hasAllowMultipleClients([]string{"--foo=allow-multiple-clients"}) {
		t.Fatal("argument value was mistaken for the option name")
	}
}

func TestInvalidPreferencesDoNotPoisonEngineState(t *testing.T) {
	backend, _ := newTestEngine(t)
	want := backend.Settings()
	if err := backend.SavePreferences("unknown", settings.StartupLast, true, true); err == nil {
		t.Fatal("invalid game was accepted")
	}
	if got := backend.Settings(); !reflect.DeepEqual(got, want) {
		t.Fatalf("settings changed after validation failure: got %+v, want %+v", got, want)
	}
}

func TestSaveRiotClientPathValidatesAndPersists(t *testing.T) {
	backend, store := newTestEngine(t)
	name := "RiotClientServices"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	executable := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(executable, []byte("test"), 0755); err != nil {
		t.Fatal(err)
	}
	resolved, err := backend.SaveRiotClientPath(executable)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != executable {
		t.Fatalf("resolved path = %q, want %q", resolved, executable)
	}
	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.RiotClientPath != executable {
		t.Fatalf("persisted path = %q, want %q", persisted.RiotClientPath, executable)
	}
}

func TestLaunchProfileSelectionPersistsAndUpdatesSnapshot(t *testing.T) {
	backend, store := newTestEngine(t)
	profile := settings.NewProfile("League main")
	profile.RiotID = "Player#EUW"
	profile.Region = "EUW1"
	profile.DefaultGame = model.GameLeague
	profile.Status = model.StatusMobile
	if err := backend.SaveLaunchProfile(profile); err != nil {
		t.Fatal(err)
	}
	if err := backend.SelectLaunchProfile(profile.ID); err != nil {
		t.Fatal(err)
	}
	if got := backend.ActiveLaunchProfile(); got.ID != profile.ID || got.RiotID != profile.RiotID {
		t.Fatalf("active profile = %+v", got)
	}
	if snapshot := backend.Snapshot(); snapshot.Game != model.GameLeague || snapshot.Status != model.StatusMobile {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.ActiveProfileID != profile.ID {
		t.Fatalf("active profile ID = %q, want %q", persisted.ActiveProfileID, profile.ID)
	}
}
