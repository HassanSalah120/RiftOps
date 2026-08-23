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

type rollingFile struct {
	mu      sync.Mutex
	path    string
	file    *os.File
	size    int64
	maxSize int64
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

func openRollingFile(path string, maxSize int64) (*rollingFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}
	if maxSize <= 0 {
		return nil, fmt.Errorf("log size limit must be positive")
	}
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		_ = os.Remove(path + ".1")
		if err := os.Rename(path, path+".1"); err != nil {
			return nil, fmt.Errorf("rotate previous debug log: %w", err)
		}
		_ = os.Chmod(path+".1", 0o600)
	} else if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect debug log: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open debug log: %w", err)
	}
	_ = os.Chmod(path, 0o600)
	return &rollingFile{path: path, file: file, maxSize: maxSize}, nil
}

func (writer *rollingFile) rotateLocked() error {
	if err := writer.file.Close(); err != nil {
		return err
	}
	_ = os.Remove(writer.path + ".1")
	if err := os.Rename(writer.path, writer.path+".1"); err != nil {
		return err
	}
	_ = os.Chmod(writer.path+".1", 0o600)
	file, err := os.OpenFile(writer.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	writer.file = file
	writer.size = 0
	return nil
}

func (writer *rollingFile) Write(content []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	originalLength := len(content)
	if int64(len(content)) > writer.maxSize {
		content = content[:writer.maxSize]
	}
	if writer.size > 0 && writer.size+int64(len(content)) > writer.maxSize {
		if err := writer.rotateLocked(); err != nil {
			return 0, err
		}
	}
	written, err := writer.file.Write(content)
	writer.size += int64(written)
	if err != nil {
		return written, err
	}
	return originalLength, nil
}

func (writer *rollingFile) Close() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.file.Close()
}

func openLogger(path string, maxSize int64) (*slog.Logger, io.Closer, error) {
	file, err := openRollingFile(path, maxSize)
	if err != nil {
		return nil, nil, err
	}
	handler := slog.NewTextHandler(&redactingWriter{destination: file}, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(handler), file, nil
}

func OpenLogger(path string) (*slog.Logger, io.Closer, error) {
	return openLogger(path, 8<<20)
}
