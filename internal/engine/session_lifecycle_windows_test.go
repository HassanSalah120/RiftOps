//go:build windows

package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/platform"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
	"github.com/HassanSalah120/RiftOps/internal/sessionvault"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

// This exercises the real engine and DPAPI vault against disposable files.
// All platform and Riot API calls are replaced; no installed client is touched.
type sessionAdapter struct {
	mu        sync.Mutex
	running   bool
	forced    int
	failClose bool
}

func (a *sessionAdapter) DiscoverRiotClient() (string, error) {
	return "", errors.New("synthetic client unavailable")
}
func (a *sessionAdapter) KnownProcesses(context.Context) ([]platform.ProcessInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.running {
		return []platform.ProcessInfo{{Name: "synthetic-riot", PID: 123}}, nil
	}
	return nil, nil
}
func (a *sessionAdapter) StopKnownProcesses(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forced++
	if a.failClose {
		return errors.New("synthetic close failed")
	}
	a.running = false
	return nil
}
func (a *sessionAdapter) Launch(context.Context, platform.LaunchRequest) (platform.Process, error) {
	return nil, errors.New("synthetic launch unavailable")
}

func engineSessionFixture(puuid, cookie, revision string) []byte {
	claims, _ := json.Marshal(map[string]string{"sub": puuid})
	token := "e30." + base64.RawURLEncoding.EncodeToString(claims) + ".signature"
	return []byte("psl:\n  authorization:\n    riot-client:\n      id_token: " + token + "\n      refresh_token: synthetic-" + revision + "\nrso-authenticator:\n  tdid:\n    value: " + cookie + "\n    domain: riotgames.com\n    expiryTime: 2000000000\n")
}

func sessionTestEngine(t *testing.T) (*Engine, *sessionAdapter, string, settings.LaunchProfile) {
	t.Helper()
	e, _ := newTestEngine(t)
	root := t.TempDir()
	dataDir := filepath.Join(root, "Data")
	os.MkdirAll(dataDir, 0700)
	e.vault.RiotDataDir = dataDir
	e.config.Profiles[0].RiotID = "Synthetic#TEST"
	profile := e.config.ActiveProfile()
	adapter := &sessionAdapter{}
	e.newPlatform = func() platform.Adapter { return adapter }
	e.readRiotAccount = func(context.Context) (riotclient.RiotAccountSession, error) {
		return riotclient.RiotAccountSession{Authorized: true, PUUID: "synthetic-puuid", RiotID: profile.RiotID}, nil
	}
	path := filepath.Join(dataDir, "RiotGamesPrivateSettings.yaml")
	os.WriteFile(path, engineSessionFixture("synthetic-puuid", "old-cookie", "one"), 0600)
	if err := e.vault.Capture(profile.ID, 30*24*time.Hour, sessionvault.Identity{PUUID: "synthetic-puuid", RiotID: profile.RiotID}); err != nil {
		t.Fatal(err)
	}
	e.requestRiotQuit = func(context.Context) error {
		adapter.mu.Lock()
		adapter.running = false
		adapter.mu.Unlock()
		return nil
	}
	return e, adapter, path, profile
}

func TestNormalEngineLaunchNeverRollsBackNativeSession(t *testing.T) {
	e, _, path, profile := sessionTestEngine(t)
	latest := engineSessionFixture("synthetic-puuid", "latest-cookie", "two")
	os.WriteFile(path, latest, 0600)
	if err := e.Run(context.Background(), RunOptions{Game: model.GameLeague}); err == nil {
		t.Fatal("expected isolated launch preflight to stop")
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(latest) {
		t.Fatal("ordinary launch restored stale state")
	}
	os.WriteFile(path, engineSessionFixture("other", "other", "other"), 0600)
	e.vault.Restore(profile.ID, profile.RiotID)
	got, _ = os.ReadFile(path)
	if string(got) != string(latest) {
		t.Fatal("normal reopen failed to preserve the newer save")
	}
}

func TestStopCapturesGracefulFinalWriteBeforeCancellation(t *testing.T) {
	e, a, path, profile := sessionTestEngine(t)
	latest := engineSessionFixture("synthetic-puuid", "settled-cookie", "final")
	a.running = true
	e.adapter = a
	e.running = true
	e.cancel = func() { e.mu.Lock(); e.running = false; e.mu.Unlock() }
	e.requestRiotQuit = func(context.Context) error {
		os.WriteFile(path, latest, 0600)
		a.mu.Lock()
		a.running = false
		a.mu.Unlock()
		return nil
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	if a.forced != 0 {
		t.Fatal("force-killed after a successful graceful quit")
	}
	os.WriteFile(path, engineSessionFixture("other", "other", "other"), 0600)
	e.vault.Restore(profile.ID, profile.RiotID)
	got, _ := os.ReadFile(path)
	if string(got) != string(latest) {
		t.Fatal("Stop discarded the final persisted session")
	}
}

func TestSwitchSavesOutgoingFinalWriteAndRestoresOnlyWhenRequested(t *testing.T) {
	e, a, path, outgoing := sessionTestEngine(t)
	target := outgoing
	target.ID = "synthetic-target"
	target.Name = "Synthetic target"
	target.RiotID = "Target#TEST"
	e.config.Profiles = append(e.config.Profiles, target)
	final := engineSessionFixture("synthetic-puuid", "final-outgoing", "final")
	a.running = true
	e.requestRiotQuit = func(context.Context) error {
		os.WriteFile(path, final, 0600)
		a.mu.Lock()
		a.running = false
		a.mu.Unlock()
		return nil
	}
	result, err := e.SwitchLaunchProfile(context.Background(), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Profile.ID != target.ID {
		t.Fatal("did not select target")
	}
	if err := e.vault.Restore(outgoing.ID, outgoing.RiotID); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(final) {
		t.Fatal("switch saved pre-quit state")
	}
}

func TestFailedShutdownDoesNotCancelOrOverwriteSave(t *testing.T) {
	e, a, _, _ := sessionTestEngine(t)
	a.running = true
	a.failClose = true
	e.adapter = a
	e.running = true
	cancelled := false
	e.cancel = func() { cancelled = true }
	e.requestRiotQuit = func(context.Context) error { return errors.New("synthetic quit unavailable") }
	if err := e.Stop(); !errors.Is(err, ErrRiotCloseFailed) {
		t.Fatal("accepted failed shutdown")
	}
	if cancelled {
		t.Fatal("cancelled runtime before session could be settled")
	}
}

func TestSameAccountSwitchUsesSessionCompletedOnQuit(t *testing.T) {
	e, a, path, profile := sessionTestEngine(t)
	os.WriteFile(path, []byte("rso-authenticator: {}"), 0600)
	if err := e.vault.Capture(profile.ID, 30*24*time.Hour, sessionvault.Identity{PUUID: "synthetic-puuid", RiotID: profile.RiotID}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.vault.LoginStatus(profile.ID); !errors.Is(err, sessionvault.ErrNotRemembered) {
		t.Fatal("fixture must start with an incomplete saved login")
	}
	a.running = true
	final := engineSessionFixture("synthetic-puuid", "completed-on-quit", "final")
	e.requestRiotQuit = func(context.Context) error {
		if err := os.WriteFile(path, final, 0600); err != nil {
			return err
		}
		a.mu.Lock()
		a.running = false
		a.mu.Unlock()
		return nil
	}
	result, err := e.SwitchLaunchProfile(context.Background(), profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.TargetSessionAvailable || result.TargetSessionUnverified || result.TargetPUUID != "synthetic-puuid" {
		t.Fatal("switch requested a fresh login after repairing the current account's save")
	}
}

func TestConfirmedCloseAndSaveCapturesPreviouslyUnwrittenLogin(t *testing.T) {
	e, a, path, profile := sessionTestEngine(t)
	e.vault.Delete(profile.ID)
	os.WriteFile(path, []byte("rso-authenticator:\n  tdid:\n    domain: riotgames.com\n    expiryTime: 2000000000\n    value: trust-only\n"), 0600)
	a.running = true
	final := engineSessionFixture("synthetic-puuid", "completed-cookie", "final")
	e.requestRiotQuit = func(context.Context) error {
		os.WriteFile(path, final, 0600)
		a.mu.Lock()
		a.running = false
		a.mu.Unlock()
		return nil
	}
	if err := e.CaptureAndCloseSavedLogin(context.Background(), 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := e.vault.LoginStatus(profile.ID); err != nil {
		t.Fatal("confirmed close did not produce a reusable save")
	}
	if a.forced != 0 {
		t.Fatal("force-killed during confirmed close/save")
	}
}

func TestCaptureWaitsForPersistedLoginWithoutClosingClient(t *testing.T) {
	e, a, path, profile := sessionTestEngine(t)
	e.vault.Delete(profile.ID)
	os.WriteFile(path, []byte("rso-authenticator: {}"), 0600)
	a.running = true
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(100 * time.Millisecond)
		os.WriteFile(path, engineSessionFixture("synthetic-puuid", "completed", "two"), 0600)
	}()
	if err := e.CaptureSavedLogin(context.Background(), 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	<-done
	if _, err := e.vault.LoginStatus(profile.ID); err != nil {
		t.Fatal("persisted login was not saved")
	}
	if !a.running || a.forced != 0 {
		t.Fatal("ordinary save closed the client")
	}
}
