package diagnostics

import (
	"log/slog"
	"os"
	"path/filepath"
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
