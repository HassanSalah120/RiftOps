package diagnostics

import (
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestOpenLoggerRedactsSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "debug.log")
	logger, closer, err := OpenLogger(path)
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("request", slog.String("authorization", "Authorization: Bearer secret-value"))
	if err := closer.Close(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "secret-value") || !strings.Contains(string(content), "[REDACTED]") {
		t.Fatalf("log was not redacted: %s", content)
	}
}

func TestOpenLoggerRotatesAndKeepsPrivateFiles(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "debug.log")
	logger, closer, err := openLogger(path, 160)
	if err != nil {
		t.Fatal(err)
	}
	for range 8 {
		logger.Info("bounded diagnostic message", "value", "abcdefghijklmnopqrstuvwxyz")
	}
	if err := closer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("expected rotated log: %v", err)
	}
	for _, name := range []string{"debug.log", "debug.log.1"} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() > 160 {
			t.Fatalf("%s exceeded size limit: %d", name, info.Size())
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("%s permissions are not private: %o", name, info.Mode().Perm())
		}
	}
}
