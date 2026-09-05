package platform

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveRiotClientExecutableFromApplicationBundle(t *testing.T) {
	root := filepath.Join(t.TempDir(), "League of Legends.app")
	executable := filepath.Join(root, "Contents", "LoL", "LeagueClient.app", "Contents", "MacOS", "LeagueClient")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	if err := os.MkdirAll(filepath.Dir(executable), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("test"), 0755); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveRiotClientExecutable(root)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != executable {
		t.Fatalf("resolved = %q, want %q", resolved, executable)
	}
}

func TestResolveRiotClientExecutableRejectsUnrelatedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-riot")
	if err := os.WriteFile(path, []byte("test"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveRiotClientExecutable(path); err == nil {
		t.Fatal("expected unrelated executable to be rejected")
	}
}

func TestResolveRiotClientExecutableRejectsTraversal(t *testing.T) {
	for _, invalid := range []string{
		"../RiotClientServices.exe",
		"foo/../../bar",
		"path\x00withnull",
	} {
		if _, err := ResolveRiotClientExecutable(invalid); err == nil {
			t.Fatalf("expected candidate %q to be rejected", invalid)
		}
	}
}

