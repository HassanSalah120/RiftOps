package qol

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPreferencesPersistAcrossManagerRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "qol.json")
	manager, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	want := Preferences{AutoAccept: true, AutoPlayAgain: true}
	if err := manager.Update(want); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	got := reloaded.Preferences()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("preferences = %#v, want %#v", got, want)
	}
}

func TestGrindModeAndRolePresets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "qol.json")
	manager, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	want := Preferences{
		AutoAccept:       true,
		AutoPlayAgain:    true,
		AutoHonor:        true,
		AutoStartQueue:   true,
		AutoClaimRewards: true,
		GrindMode:        true,
		RolePresets: map[string]RolePreset{
			"ranked_solo": {First: "MIDDLE", Second: "TOP"},
			"aram":        {First: "FILL", Second: "FILL"},
		},
	}
	if err := manager.Update(want); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	got := reloaded.Preferences()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("preferences = %#v, want %#v", got, want)
	}
}

func TestPreferencesReturnsIsolatedMutableFields(t *testing.T) {
	manager, err := NewManager(filepath.Join(t.TempDir(), "qol.json"))
	if err != nil {
		t.Fatal(err)
	}
	flow := DefaultPlayFlowPreferences()
	flow.RolePickPlans = map[string]RolePickPlan{"TOP": {PickChampionID: 86}}
	if err := manager.Update(Preferences{
		RolePresets: map[string]RolePreset{"ranked_solo": {First: "TOP", Second: "JUNGLE"}},
		PlayFlow:    &flow,
	}); err != nil {
		t.Fatal(err)
	}
	copy := manager.Preferences()
	copy.RolePresets["ranked_solo"] = RolePreset{First: "MIDDLE", Second: "BOTTOM"}
	copy.PlayFlow.PrimaryRole = "UTILITY"
	copy.PlayFlow.RolePickPlans["TOP"] = RolePickPlan{PickChampionID: 19}
	current := manager.Preferences()
	if current.RolePresets["ranked_solo"].First != "TOP" || current.PlayFlow.PrimaryRole != "TOP" || current.PlayFlow.RolePickPlans["TOP"].PickChampionID != 86 {
		t.Fatalf("Preferences exposed mutable manager state: %#v", current)
	}
}

func TestUpdateClampsAutoAcceptDelay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "qol.json")
	manager, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := manager.Update(Preferences{AutoAcceptDelaySeconds: 99}); err != nil {
		t.Fatal(err)
	}
	if got := manager.Preferences().AutoAcceptDelaySeconds; got != MaxAutoAcceptDelaySeconds {
		t.Fatalf("delay after Update = %d, want %d", got, MaxAutoAcceptDelaySeconds)
	}

	reloaded, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Preferences().AutoAcceptDelaySeconds; got != MaxAutoAcceptDelaySeconds {
		t.Fatalf("persisted delay = %d, want %d", got, MaxAutoAcceptDelaySeconds)
	}

	if err := manager.Update(Preferences{AutoAcceptDelaySeconds: -1}); err != nil {
		t.Fatal(err)
	}
	if got := manager.Preferences().AutoAcceptDelaySeconds; got != 0 {
		t.Fatalf("negative delay after Update = %d, want 0", got)
	}
}

func TestNewManagerClampsPersistedAutoAcceptDelay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "qol.json")
	if err := os.WriteFile(path, []byte(`{"autoAcceptDelaySeconds":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := manager.Preferences().AutoAcceptDelaySeconds; got != MaxAutoAcceptDelaySeconds {
		t.Fatalf("loaded delay = %d, want %d", got, MaxAutoAcceptDelaySeconds)
	}
}

func TestNormalizePlayFlowPreferencesBoundsTimingAndCanonicalizesRoles(t *testing.T) {
	preferences := DefaultPlayFlowPreferences()
	preferences.PrimaryRole = " middle "
	preferences.SecondaryRole = "top"
	preferences.PickTimingMode = "after"
	preferences.PickTimingSeconds = 999
	preferences.BanTimingMode = "last-second"
	preferences.BanTimingSeconds = -3
	preferences.AutoAcceptDelaySeconds = 99

	normalized, err := NormalizePlayFlowPreferences(preferences)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.PrimaryRole != "MIDDLE" || normalized.SecondaryRole != "TOP" {
		t.Fatalf("roles = %q/%q", normalized.PrimaryRole, normalized.SecondaryRole)
	}
	if normalized.PickTimingSeconds != MaxPlayFlowTimingSeconds || normalized.BanTimingSeconds != 0 || normalized.AutoAcceptDelaySeconds != MaxAutoAcceptDelaySeconds {
		t.Fatalf("timings = pick %d, ban %d, accept %d", normalized.PickTimingSeconds, normalized.BanTimingSeconds, normalized.AutoAcceptDelaySeconds)
	}
	if normalized.AutoPickOrderTarget != "latest" {
		t.Fatalf("default pick-order target = %q, want latest", normalized.AutoPickOrderTarget)
	}
}

func TestNormalizePlayFlowPreferencesAcceptsRolePickPlans(t *testing.T) {
	preferences := DefaultPlayFlowPreferences()
	preferences.RoleAwarePicks = true
	preferences.RolePickPlans = map[string]RolePickPlan{
		"JUNGLE": {PickChampionID: 19, FallbackPickChampionID: 32, PickRunePageID: 4},
	}

	normalized, err := NormalizePlayFlowPreferences(preferences)
	if err != nil {
		t.Fatal(err)
	}
	if !normalized.RoleAwarePicks || normalized.RolePickPlans["JUNGLE"].PickChampionID != 19 {
		t.Fatalf("role-aware plan = %#v", normalized.RolePickPlans)
	}
}

func TestNormalizePlayFlowPreferencesRejectsInvalidValues(t *testing.T) {
	base := DefaultPlayFlowPreferences()
	for _, test := range []struct {
		name   string
		mutate func(*PlayFlowPreferences)
	}{
		{"unknown role", func(value *PlayFlowPreferences) { value.PrimaryRole = "MIDLANE" }},
		{"duplicate roles", func(value *PlayFlowPreferences) { value.SecondaryRole = value.PrimaryRole }},
		{"unknown timing", func(value *PlayFlowPreferences) { value.PickTimingMode = "random" }},
		{"negative queue", func(value *PlayFlowPreferences) { value.SelectedQueue = -1 }},
		{"negative champion", func(value *PlayFlowPreferences) { value.PickChampionID = -4 }},
		{"unknown pick-order target", func(value *PlayFlowPreferences) { value.AutoPickOrderTarget = "pick-6" }},
		{"unknown role pick plan", func(value *PlayFlowPreferences) {
			value.RolePickPlans = map[string]RolePickPlan{"FILL": {PickChampionID: 19}}
		}},
		{"negative role pick champion", func(value *PlayFlowPreferences) {
			value.RolePickPlans = map[string]RolePickPlan{"JUNGLE": {PickChampionID: -19}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := base
			test.mutate(&value)
			if _, err := NormalizePlayFlowPreferences(value); err == nil {
				t.Fatal("invalid Play & Queue policy was accepted")
			}
		})
	}
}

func TestNormalizeRolePresetCanonicalizesAndRejectsDuplicates(t *testing.T) {
	preset, err := NormalizeRolePreset(RolePreset{First: " middle ", Second: "top"})
	if err != nil || preset.First != "MIDDLE" || preset.Second != "TOP" {
		t.Fatalf("normalized preset = %#v, err = %v", preset, err)
	}
	if _, err := NormalizeRolePreset(RolePreset{First: "FILL", Second: "FILL"}); err == nil {
		t.Fatal("duplicate role preset was accepted")
	}
}

func TestManagerUpdateRejectsInvalidPlayFlowPreferences(t *testing.T) {
	manager, err := NewManager(filepath.Join(t.TempDir(), "qol.json"))
	if err != nil {
		t.Fatal(err)
	}
	preferences := Preferences{PlayFlow: func() *PlayFlowPreferences {
		value := DefaultPlayFlowPreferences()
		value.BanTimingMode = "invalid"
		return &value
	}()}
	if err := manager.Update(preferences); err == nil {
		t.Fatal("invalid Play & Queue policy was persisted")
	}
}
