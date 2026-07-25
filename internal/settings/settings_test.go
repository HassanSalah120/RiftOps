package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/model"
)

func TestStoreRoundTrip(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "nested", "settings.json")}
	want := Default()
	want.UpdateActiveRuntime(true, model.StatusMobile)
	want.UpdateActivePreferences(model.GameLeague, want.StartupStatus, want.ConnectToMUC)
	if err := store.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMigrateLegacyDirectory(t *testing.T) {
	directory := t.TempDir()
	files := map[string]string{
		"status": "mobile", "launchGame": "LoL", "startupStatus": "offline",
		"introductionShown": "", "updateVersionPrompted": "v1.12.0",
	}
	for name, value := range files {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got, ok := MigrateLegacyDirectory(directory, Default())
	if !ok || got.Status != model.StatusMobile || got.DefaultGame != model.GameLeague || got.StartupStatus != StartupStatus(model.StatusOffline) ||
		!got.IntroductionShown || got.PromptedUpdate != "v1.12.0" {
		t.Fatalf("migration = %+v, ok=%v", got, ok)
	}
}

func TestLoadPriorJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	want := Default()
	want.UpdateActiveRuntime(true, model.StatusMobile)
	want.UpdateActivePreferences(model.GameLeague, want.StartupStatus, want.ConnectToMUC)
	data, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	got, ok := loadPriorJSON(path, Default())
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("migration = %+v, ok=%v; want %+v", got, ok, want)
	}
}

func TestMissingStoreReturnsDefaults(t *testing.T) {
	got, err := (Store{Path: filepath.Join(t.TempDir(), "none.json")}).Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, Default()) {
		t.Fatalf("got %+v", got)
	}
}

func TestVersionOneSettingsBecomeDefaultProfile(t *testing.T) {
	data := []byte(`{"version":1,"enabled":true,"status":"mobile","startupStatus":"last","defaultGame":"lol","connectToMUC":true,"checkUpdates":true}`)
	got, err := decodeSettings(data, Default())
	if err != nil {
		t.Fatal(err)
	}
	profile := got.ActiveProfile()
	if got.Version != CurrentVersion || len(got.Profiles) != 1 || profile.Status != model.StatusMobile || profile.DefaultGame != model.GameLeague {
		t.Fatalf("upgraded settings = %+v", got)
	}
}

func TestLaunchProfileCRUD(t *testing.T) {
	value := Default()
	profile := NewProfile("Ranked account")
	profile.AccountLabel = "Main"
	profile.RiotID = "Player#EUW"
	profile.Region = "euw1"
	if err := value.UpsertProfile(profile); err != nil {
		t.Fatal(err)
	}
	if err := value.SelectProfile(profile.ID); err != nil {
		t.Fatal(err)
	}
	if got := value.ActiveProfile(); got.Region != "EUW1" || got.RiotID != profile.RiotID {
		t.Fatalf("active profile = %+v", got)
	}
	if err := value.DeleteProfile(profile.ID); err != nil {
		t.Fatal(err)
	}
	if value.ActiveProfileID != DefaultProfileID || len(value.Profiles) != 1 {
		t.Fatalf("profiles after delete = %+v", value)
	}
}

func TestLaunchProfileRejectsCredentialArguments(t *testing.T) {
	profile := NewProfile("Unsafe")
	profile.RiotClientArgs = []string{"--auth-token=secret"}
	if err := profile.Validate(); err == nil {
		t.Fatal("expected credential-bearing arguments to be rejected")
	}
}
