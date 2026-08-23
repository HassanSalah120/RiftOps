package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRunMarkerReportsPreviousUncleanExit(t *testing.T) {
	oldReportDir := reportDir
	oldMarkerPath := runMarkerPath
	oldGraceful := gracefulExit.Load()
	defer func() {
		reportDir = oldReportDir
		runMarkerPath = oldMarkerPath
		gracefulExit.Store(oldGraceful)
	}()

	dataDir := t.TempDir()
	initReports(filepath.Join(dataDir, "reports"))
	previous, err := json.Marshal(runMarker{
		PID:       1234,
		StartedAt: "2026-08-23T12:00:00Z",
		Version:   "test-version",
		OS:        "windows",
		Arch:      "amd64",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "run-state.json"), previous, 0o644); err != nil {
		t.Fatal(err)
	}

	initRunMarker(dataDir)

	entries, err := os.ReadDir(reportDir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "unclean-exit-") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected an unclean-exit report, got %v", entries)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "run-state.json")); err != nil {
		t.Fatalf("expected current run marker: %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dataDir, "run-state.json"))
		if err != nil || info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("run marker is not private: info=%v err=%v", info, err)
		}
	}

	markCleanExit("test complete")
	if _, err := os.Stat(filepath.Join(dataDir, "run-state.json")); !os.IsNotExist(err) {
		t.Fatalf("expected clean shutdown to remove marker, got %v", err)
	}
}

func TestReportsAreRedactedPrivateAndRetained(t *testing.T) {
	oldReportDir := reportDir
	defer func() { reportDir = oldReportDir }()
	directory := filepath.Join(t.TempDir(), "reports")
	initReports(directory)

	oldPath := filepath.Join(directory, "old-report.txt")
	if err := os.WriteFile(oldPath, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-reportMaxAge - time.Hour)
	if err := os.Chtimes(oldPath, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	for index := range maxSavedReports + 5 {
		path := filepath.Join(directory, "report-"+time.Now().Add(time.Duration(index)*time.Second).Format("150405.000000000")+".txt")
		if err := os.WriteFile(path, []byte("report"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pruneReports(time.Now())
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != maxSavedReports {
		t.Fatalf("retained %d reports, want %d", len(entries), maxSavedReports)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("expired report was retained: %v", err)
	}

	writeReport("privacy", "Authorization: Basic secret-value pair=pair-secret C:\\Users\\person\\RiftOps")
	entries, err = os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "privacy-") {
			continue
		}
		content, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if strings.Contains(string(content), "secret-value") || strings.Contains(string(content), "pair-secret") || strings.Contains(string(content), "person") {
			t.Fatalf("report leaked private data: %s", content)
		}
		if runtime.GOOS != "windows" {
			info, statErr := entry.Info()
			if statErr != nil || info.Mode().Perm()&0o077 != 0 {
				t.Fatalf("report is not private: info=%v err=%v", info, statErr)
			}
		}
		return
	}
	t.Fatal("privacy report was not written")
}
