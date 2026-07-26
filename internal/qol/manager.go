package qol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

type Preferences struct {
	AutoAccept    bool `json:"autoAccept"`
	AutoPlayAgain bool `json:"autoPlayAgain"`
}

type Manager struct {
	mu          sync.RWMutex
	path        string
	preferences Preferences
}

func NewManager(path string) (*Manager, error) {
	manager := &Manager{path: path}
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &manager.preferences); err != nil {
			return manager, fmt.Errorf("decode QoL preferences: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return manager, fmt.Errorf("read QoL preferences: %w", err)
	}
	return manager, nil
}

func (m *Manager) Preferences() Preferences {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.preferences
}

func (m *Manager) Update(preferences Preferences) error {
	data, err := json.MarshalIndent(preferences, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(m.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, "qol-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := atomicfile.Replace(temporaryPath, m.path); err != nil {
		return err
	}

	m.mu.Lock()
	m.preferences = preferences
	m.mu.Unlock()
	return nil
}

// Run keeps the small, opt-in automations alive even when the QoL page is not
// visible. Each action is attempted only once per matching gameflow phase.
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	lastPhase := ""
	handled := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lockfile := riotclient.GetLCULockfile()
			if lockfile == nil {
				lastPhase, handled = "", false
				continue
			}
			requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			phase, err := lockfile.GetGameflowPhase(requestCtx)
			cancel()
			if err != nil {
				continue
			}
			if phase != lastPhase {
				lastPhase, handled = phase, false
			}
			if handled {
				continue
			}

			preferences := m.Preferences()
			switch {
			case preferences.AutoAccept && phase == "ReadyCheck":
				actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
				err = lockfile.AcceptReadyCheck(actionCtx)
				actionCancel()
				if err == nil {
					handled = true
					slog.Info("qol: automatically accepted ready check")
				}
			case preferences.AutoPlayAgain && phase == "EndOfGame":
				actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
				err = lockfile.PlayAgain(actionCtx)
				actionCancel()
				if err == nil {
					handled = true
					slog.Info("qol: automatically returned to lobby")
				}
			}
		}
	}
}
