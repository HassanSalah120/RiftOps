package diagnostics

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

type redactingWriter struct {
	mu          sync.Mutex
	destination io.Writer
}

func (writer *redactingWriter) Write(content []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	redacted := []byte(Redact(string(content)))
	if _, err := writer.destination.Write(redacted); err != nil {
		return 0, err
	}
	return len(content), nil
}

func OpenLogger(path string) (*slog.Logger, io.Closer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, fmt.Errorf("create log directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, nil, fmt.Errorf("open debug log: %w", err)
	}
	handler := slog.NewTextHandler(&redactingWriter{destination: file}, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(handler), file, nil
}
