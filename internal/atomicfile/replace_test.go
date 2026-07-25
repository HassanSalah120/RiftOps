package atomicfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceExistingFile(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source.tmp")
	destination := filepath.Join(directory, "destination.json")
	if err := os.WriteFile(source, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Replace(source, destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new" {
		t.Fatalf("destination = %q", content)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("source still exists: %v", err)
	}
}
