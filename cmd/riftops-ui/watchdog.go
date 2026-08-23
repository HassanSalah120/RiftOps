package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"sync/atomic"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/buildinfo"
	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
	"github.com/HassanSalah120/RiftOps/internal/singleinstance"
)

// Crash and hang reporting. When the UI thread stalls (Windows marks the app
// "not responding") or a handler panics, RiftOps writes a timestamped report
// with a full goroutine stack dump to <data dir>/reports so the freeze can be
// diagnosed after the fact.

var (
	reportDir       string
	lastUIBeatNano  atomic.Int64
	hangReported    atomic.Bool
	hangSinceNano   atomic.Int64
	restarting      atomic.Bool
	appLockInstance singleinstance.Lock
	runMarkerPath   string
	gracefulExit    atomic.Bool
)

type runMarker struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
	Version   string `json:"version"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
}

// restartThreshold is how long the UI may stay wedged before RiftOps restarts
// itself. A wedged WebView2 pump thread never recovers on its own.
const restartThreshold = 90 * time.Second

const (
	maxSavedReports = 20
	reportMaxAge    = 30 * 24 * time.Hour
)

// restartSelf launches a fresh copy of this executable and exits, releasing
// the single-instance lock first so the new process can acquire it.
func restartSelf() {
	if appLockInstance != nil {
		_ = appLockInstance.Close()
	}
	exe, err := os.Executable()
	if err != nil {
		slog.Error("restart aborted: cannot resolve executable", "error", err)
		return
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	if err := cmd.Start(); err != nil {
		slog.Error("restart failed to spawn new process", "error", err)
		return
	}
	markCleanExit("watchdog restart after a saved hang report")
	slog.Info("restarted RiftOps after UI hang")
	time.Sleep(300 * time.Millisecond)
	shutdownHTTPServer()
	os.Exit(0)
}

func initReports(dir string) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Warn("Could not create reports directory", "dir", dir, "error", err)
		return
	}
	_ = os.Chmod(dir, 0o700)
	reportDir = dir
	pruneReports(time.Now())
}

func pruneReports(now time.Time) {
	if reportDir == "" {
		return
	}
	entries, err := os.ReadDir(reportDir)
	if err != nil {
		return
	}
	type candidate struct {
		name    string
		modTime time.Time
	}
	reports := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".txt" {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr == nil {
			reports = append(reports, candidate{name: entry.Name(), modTime: info.ModTime()})
		}
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].modTime.After(reports[j].modTime) })
	for index, report := range reports {
		if index >= maxSavedReports || now.Sub(report.modTime) > reportMaxAge {
			_ = os.Remove(filepath.Join(reportDir, report.name))
		}
	}
}

// initRunMarker records that this process is active. If a marker from a
// previous run is still present, that process ended outside RiftOps' normal
// shutdown path (for example a native WebView crash or forced termination).
// The next launch turns that otherwise invisible failure into a report.
func initRunMarker(dataDir string) {
	runMarkerPath = filepath.Join(dataDir, "run-state.json")
	if raw, err := os.ReadFile(runMarkerPath); err == nil {
		var previous runMarker
		if json.Unmarshal(raw, &previous) == nil {
			writeReport("unclean-exit", fmt.Sprintf("previous process did not record a clean shutdown; pid=%d started=%s version=%s os/arch=%s/%s", previous.PID, previous.StartedAt, previous.Version, previous.OS, previous.Arch))
		} else {
			writeReport("unclean-exit", "previous process left an unreadable run marker and did not record a clean shutdown")
		}
	} else if !os.IsNotExist(err) {
		slog.Warn("Could not inspect previous run marker", "path", runMarkerPath, "error", err)
	}

	marker, err := json.MarshalIndent(runMarker{
		PID:       os.Getpid(),
		StartedAt: time.Now().Format(time.RFC3339),
		Version:   buildinfo.Version,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
	}, "", "  ")
	if err != nil {
		slog.Warn("Could not encode run marker", "error", err)
		return
	}
	if err := os.WriteFile(runMarkerPath, marker, 0o600); err != nil {
		slog.Warn("Could not write run marker", "path", runMarkerPath, "error", err)
	} else {
		// os.WriteFile does not change permissions when refreshing an existing
		// marker. Re-apply the private mode so a stale 0644 marker cannot leak
		// process metadata on Unix systems.
		_ = os.Chmod(runMarkerPath, 0o600)
	}
}

func clearRunMarker() {
	if runMarkerPath == "" {
		return
	}
	if err := os.Remove(runMarkerPath); err != nil && !os.IsNotExist(err) {
		slog.Warn("Could not clear run marker", "path", runMarkerPath, "error", err)
	}
}

func markCleanExit(reason string) {
	gracefulExit.Store(true)
	slog.Info("RiftOps clean shutdown", "reason", reason)
	clearRunMarker()
}

// writeReport dumps process state into a timestamped report file.
func writeReport(kind, reason string) {
	if reportDir == "" {
		return
	}
	now := time.Now()
	pruneReports(now)
	name := fmt.Sprintf("%s-%s.txt", kind, now.Format("20060102-150405.000000000"))
	path := filepath.Join(reportDir, name)

	stack := make([]byte, 4<<20)
	n := runtime.Stack(stack, true)

	content := fmt.Sprintf("RiftOps %s report\nversion: %s\ngo: %s\nos/arch: %s/%s\ntime: %s\nreason: %s\n\n== goroutine dump ==\n%s",
		kind, buildinfo.Version, runtime.Version(), runtime.GOOS, runtime.GOARCH,
		now.Format(time.RFC3339), reason, stack[:n])
	content = diagnostics.Redact(content)

	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		slog.Error("Could not write report file", "path", path, "error", err)
		return
	}
	_ = os.Chmod(path, 0o600)
	pruneReports(time.Now())
	slog.Error("Wrote "+kind+" report", "path", path)
}

// recoveryMiddleware turns handler panics into crash reports instead of
// taking the whole HTTP server down.
func recoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				writeReport("panic", fmt.Sprintf("panic in %s %s: %v\n\nhandler stack:\n%s", r.Method, r.URL.Path, rec, debug.Stack()))
				http.Error(w, "RiftOps hit an unexpected error. A crash report was saved.", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// startHangWatchdog monitors two signals that indicate the UI is frozen:
//  1. UI-thread heartbeat — a callback dispatched through the native WebView
//     message loop stops arriving when the loop thread is blocked.
//  2. Local API probe — the loopback HTTP server should always answer quickly.
//
// Reports are written once per incident; recovery resets the latch.
func startHangWatchdog() {
	lastUIBeatNano.Store(time.Now().UnixNano())
	go func() {
		const (
			interval    = 5 * time.Second
			uiThreshold = 20 * time.Second
			httpLimit   = 4 // consecutive failures before flagging
		)
		httpFails := 0
		client := &http.Client{Timeout: 3 * time.Second}

		for {
			time.Sleep(interval)
			uiStalled := false

			// 1. Probe the native WebView message pump (Windows and macOS).
			if pumpUIThread(func() { lastUIBeatNano.Store(time.Now().UnixNano()) }) {
				last := time.Unix(0, lastUIBeatNano.Load())
				if age := time.Since(last); age > uiThreshold {
					uiStalled = true
				}
			}

			// 2. Probe the local API server.
			resp, err := client.Get(clientURL + "/api/lcu/health")
			if err != nil {
				httpFails++
			} else {
				resp.Body.Close()
				httpFails = 0
			}

			apiStalled := httpFails >= httpLimit
			if !uiStalled && !apiStalled {
				hangReported.Store(false)
				hangSinceNano.Store(0)
				continue
			}

			if hangSinceNano.Load() == 0 {
				hangSinceNano.Store(time.Now().UnixNano())
			}
			if !hangReported.Swap(true) {
				switch {
				case uiStalled && apiStalled:
					writeReport("hang", fmt.Sprintf("UI message loop and local API are unresponsive; API failed %d checks: %v", httpFails, err))
				case uiStalled:
					age := time.Since(time.Unix(0, lastUIBeatNano.Load())).Round(time.Second)
					writeReport("hang", fmt.Sprintf("UI message loop unresponsive for %s; window shows 'not responding'", age))
				default:
					writeReport("hang", fmt.Sprintf("local API unreachable %d checks in a row: %v", httpFails, err))
				}
			}

			// The WebView2 pump thread never recovers once it wedges inside a
			// blocking Win32 call, so a prolonged stall is unrecoverable.
			// Restart the whole process to self-heal instead of hanging until
			// the user kills it manually.
			if hangStart := hangSinceNano.Load(); hangStart != 0 && time.Since(time.Unix(0, hangStart)) > restartThreshold {
				if !restarting.Swap(true) {
					writeReport("restart", fmt.Sprintf("UI stayed unresponsive for %s; restarting RiftOps automatically", time.Since(time.Unix(0, hangStart)).Round(time.Second)))
					slog.Error("UI unresponsive beyond recovery threshold; restarting app")
					go func() {
						time.Sleep(500 * time.Millisecond)
						restartSelf()
					}()
				}
			}
		}
	}()
}
