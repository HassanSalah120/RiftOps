package qol

import (
	"path/filepath"
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
	if got := reloaded.Preferences(); got != want {
		t.Fatalf("preferences = %#v, want %#v", got, want)
	}
}
