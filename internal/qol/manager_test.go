package qol

import (
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
		AutoAccept:      true,
		AutoPlayAgain:   true,
		AutoHonor:       true,
		AutoStartQueue:  true,
		AutoClaimRewards: true,
		GrindMode:       true,
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
