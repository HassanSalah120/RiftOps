//go:build windows || darwin

package singleinstance

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestAcquireIsExclusiveAndReusable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "riftops.lock")
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(path); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second Acquire() error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire() after close = %v", err)
	}
	if err := third.Close(); err != nil {
		t.Fatal(err)
	}
}
