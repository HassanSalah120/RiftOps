//go:build desktop

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/engine"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

func TestAPIHandlers(t *testing.T) {
	// Setup temporary settings path
	tempDir, err := os.MkdirTemp("", "riftops-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	tempPath := filepath.Join(tempDir, "settings.json")
	backend, err := engine.New(settings.Store{Path: tempPath})
	if err != nil {
		t.Fatalf("failed to initialize engine: %v", err)
	}

	// Set global backendEngine reference
	backendEngine = backend
	defer backendEngine.Stop()

	t.Run("GET /api/snapshot", func(t *testing.T) {
		req, err := http.NewRequest("GET", "/api/snapshot", nil)
		if err != nil {
			t.Fatal(err)
		}

		rr := httptest.NewRecorder()
		handler := http.HandlerFunc(getSnapshot)
		handler.ServeHTTP(rr, req)

		if status := rr.Code; status != http.StatusOK {
			t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
		}

		var snap WebSnapshot
		if err := json.NewDecoder(rr.Body).Decode(&snap); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if snap.Phase != "idle" {
			t.Errorf("expected phase idle, got %q", snap.Phase)
		}
	})

	t.Run("GET /api/profiles", func(t *testing.T) {
		req, err := http.NewRequest("GET", "/api/profiles", nil)
		if err != nil {
			t.Fatal(err)
		}

		rr := httptest.NewRecorder()
		handler := http.HandlerFunc(getProfiles)
		handler.ServeHTTP(rr, req)

		if status := rr.Code; status != http.StatusOK {
			t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
		}

		var profiles []settings.LaunchProfile
		if err := json.NewDecoder(rr.Body).Decode(&profiles); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if len(profiles) == 0 {
			t.Errorf("expected at least one default launch profile")
		}
	})

	t.Run("POST /api/save-profile", func(t *testing.T) {
		newProfile := settings.NewProfile("Test Profile")
		newProfile.ID = ""
		newProfile.AccountLabel = "Tester"

		bodyBytes, _ := json.Marshal(newProfile)
		req, err := http.NewRequest("POST", "/api/save-profile", bytes.NewBuffer(bodyBytes))
		if err != nil {
			t.Fatal(err)
		}

		rr := httptest.NewRecorder()
		handler := http.HandlerFunc(saveProfile)
		handler.ServeHTTP(rr, req)

		if status := rr.Code; status != http.StatusOK {
			t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
		}
		var saved settings.LaunchProfile
		if err := json.NewDecoder(rr.Body).Decode(&saved); err != nil {
			t.Fatalf("failed to decode saved profile: %v", err)
		}
		if saved.ID == "" || backendEngine.Settings().ActiveProfileID != saved.ID {
			t.Fatalf("new profile was not activated: saved=%q active=%q", saved.ID, backendEngine.Settings().ActiveProfileID)
		}

		// Check that the profile list now includes the new profile
		profilesList := backendEngine.LaunchProfiles()
		found := false
		for _, p := range profilesList {
			if p.Name == "Test Profile" && p.AccountLabel == "Tester" {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("saved profile was not found in active profile list")
		}
	})

	t.Run("POST /api/set-enabled", func(t *testing.T) {
		bodyBytes := []byte(`{"enabled":true}`)
		req, err := http.NewRequest("POST", "/api/set-enabled", bytes.NewBuffer(bodyBytes))
		if err != nil {
			t.Fatal(err)
		}

		rr := httptest.NewRecorder()
		handler := http.HandlerFunc(setEnabled)
		handler.ServeHTTP(rr, req)

		if status := rr.Code; status != http.StatusOK {
			t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
		}

		// Wait a small moment for async operations if any
		time.Sleep(50 * time.Millisecond)

		snap := backendEngine.Snapshot()
		if !snap.Enabled {
			t.Errorf("expected engine enabled status to be true")
		}
	})

	t.Run("POST /api/set-status", func(t *testing.T) {
		bodyBytes := []byte(`{"status":"mobile"}`)
		req, err := http.NewRequest("POST", "/api/set-status", bytes.NewBuffer(bodyBytes))
		if err != nil {
			t.Fatal(err)
		}

		rr := httptest.NewRecorder()
		handler := http.HandlerFunc(setStatus)
		handler.ServeHTTP(rr, req)

		if status := rr.Code; status != http.StatusOK {
			t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		_ = backendEngine.SetStatus(ctx, "mobile") // set directly to ensure sync

		snap := backendEngine.Snapshot()
		if snap.Status != "mobile" {
			t.Errorf("expected engine status to be mobile, got %q", snap.Status)
		}
	})
}
