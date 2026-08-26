package buildinfo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultVersionMatchesVersionFile(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.TrimSpace(string(data))
	if Version != want {
		t.Fatalf("default build version = %q, VERSION file = %q", Version, want)
	}
}
