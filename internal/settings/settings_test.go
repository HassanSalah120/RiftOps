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

func TestVersionTwoProfilesMigrateLeagueLocale(t *testing.T) {
	data := []byte(`{"version":2,"profiles":[{"id":"main","name":"Main","status":"chat","defaultGame":"lol","startupStatus":"last","connectToMUC":true,"patchline":"live"}],"activeProfileId":"main"}`)
	got, err := decodeSettings(data, Default())
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != CurrentVersion || got.ActiveProfile().LeagueLocale != DefaultLeagueLocale {
		t.Fatalf("v2 migration = %+v", got.ActiveProfile())
	}
}

func TestLaunchProfileRejectsUnsupportedLeagueLocale(t *testing.T) {
	profile := NewProfile("Locale")
	profile.LeagueLocale = "xx_XX"
	if err := profile.Validate(); err == nil {
		t.Fatal("expected unsupported League locale to be rejected")
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
	profile.Name = "Ranked account renamed"
	profile.AccountLabel = "Secondary"
	profile.RiotID = "Updated#EUW"
	profile.Region = "eun1"
	profile.LeagueLocale = "en_GB"
	if err := value.UpsertProfile(profile); err != nil {
		t.Fatal(err)
	}
	updated := value.ActiveProfile()
	if updated.ID != profile.ID || updated.Name != profile.Name || updated.AccountLabel != profile.AccountLabel || updated.RiotID != profile.RiotID || updated.Region != "EUN1" || updated.LeagueLocale != profile.LeagueLocale {
		t.Fatalf("updated profile = %+v", updated)
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

func TestUpsertProfilePreservesExistingMetadata(t *testing.T) {
	s := Default()
	p := NewProfile("Full Custom")
	p.StartupStatus = StartupStatus(model.StatusMobile)
	p.Status = model.StatusMobile
	p.DefaultGame = model.GameLeague
	p.Patchline = "pbe"
	p.LeagueLocale = "fr_FR"
	p.ConnectToMUC = true
	p.RiotClientArgs = []string{"--no-screensaver"}
	p.GameArgs = []string{"-novid"}
	p.GameStatuses = map[model.Game]model.Status{model.GameLeague: model.StatusMobile}

	if err := s.UpsertProfile(p); err != nil {
		t.Fatalf("failed to insert initial profile: %v", err)
	}

	// Partial update omitting all the technical settings
	partial := LaunchProfile{
		ID:            p.ID,
		Name:          "Full Custom Renamed",
		RiotID:        "Custom#FR1",
		Region:        "EUW",
		AccountLabel:  "New Label",
		LoginUsername: "custom_user",
	}

	if err := s.UpsertProfile(partial); err != nil {
		t.Fatalf("failed to upsert partial profile: %v", err)
	}

	var found LaunchProfile
	for _, cand := range s.Profiles {
		if cand.ID == p.ID {
			found = cand
			break
		}
	}

	if found.Name != "Full Custom Renamed" || found.RiotID != "Custom#FR1" || found.Region != "EUW" || found.AccountLabel != "New Label" || found.LoginUsername != "custom_user" {
		t.Fatalf("identity fields not updated properly: %+v", found)
	}
	if found.Patchline != "pbe" {
		t.Errorf("patchline not preserved: expected 'pbe', got %q", found.Patchline)
	}
	if found.StartupStatus != StartupStatus(model.StatusMobile) {
		t.Errorf("startupStatus not preserved: expected 'mobile', got %q", found.StartupStatus)
	}
	if found.Status != model.StatusMobile {
		t.Errorf("status not preserved: expected 'mobile', got %q", found.Status)
	}
	if found.LeagueLocale != "fr_FR" {
		t.Errorf("leagueLocale not preserved: expected 'fr_FR', got %q", found.LeagueLocale)
	}
	if !found.ConnectToMUC {
		t.Errorf("connectToMUC not preserved")
	}
	if len(found.RiotClientArgs) != 1 || found.RiotClientArgs[0] != "--no-screensaver" {
		t.Errorf("riotClientArgs not preserved: %+v", found.RiotClientArgs)
	}
	if len(found.GameArgs) != 1 || found.GameArgs[0] != "-novid" {
		t.Errorf("gameArgs not preserved: %+v", found.GameArgs)
	}
}
