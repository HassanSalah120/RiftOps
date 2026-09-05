package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/systray"
	"github.com/HassanSalah120/RiftOps/internal/buildinfo"
	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
	"github.com/HassanSalah120/RiftOps/internal/engine"
	"github.com/HassanSalah120/RiftOps/internal/featurestore"
	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/platform"
	"github.com/HassanSalah120/RiftOps/internal/qol"
	"github.com/HassanSalah120/RiftOps/internal/riotapi"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
	"github.com/HassanSalah120/RiftOps/internal/sessionvault"
	"github.com/HassanSalah120/RiftOps/internal/settings"
	"github.com/HassanSalah120/RiftOps/internal/singleinstance"
	"github.com/HassanSalah120/RiftOps/internal/update"
)

//go:embed frontend/dist
var frontendFS embed.FS

//go:embed app.ico
var appIco []byte

//go:embed app.png
var appPng []byte

var (
	backendEngine *engine.Engine
	qolManager    *qol.Manager
	featureData   *featurestore.Store
	preferredPort = 24080
	port          = preferredPort
	clientURL     = fmt.Sprintf("http://127.0.0.1:%d", port)
	portFileName  = "ui-port"

	httpServer *http.Server

	// dashboardMux keeps the loopback route table reachable from handlers that
	// must attach it to the optional phone listener.
	dashboardMux atomic.Value

	mOnline  *systray.MenuItem
	mOffline *systray.MenuItem
	mMobile  *systray.MenuItem
	mMasking *systray.MenuItem
	mStop    *systray.MenuItem
)

// broker manages SSE event distribution
type sseBroker struct {
	snapshots  chan WebSnapshot
	newClients chan chan WebSnapshot
	defClients chan chan WebSnapshot
	once       sync.Once
}

var broker = &sseBroker{
	snapshots:  make(chan WebSnapshot, 16),
	newClients: make(chan chan WebSnapshot),
	defClients: make(chan chan WebSnapshot),
}

func (b *sseBroker) Start() {
	b.once.Do(func() {
		go func() {
			clients := map[chan WebSnapshot]struct{}{}
			for {
				select {
				case c := <-b.newClients:
					clients[c] = struct{}{}
				case c := <-b.defClients:
					delete(clients, c)
					close(c)
				case snap := <-b.snapshots:
					for c := range clients {
						select {
						case c <- snap:
						default:
						}
					}
				}
			}
		}()
	})
}

type WebSnapshot struct {
	Version         string            `json:"Version"`
	Platform        string            `json:"Platform"`
	Phase           string            `json:"Phase"`
	Detail          string            `json:"Detail"`
	Game            string            `json:"Game"`
	Status          string            `json:"Status"`
	Enabled         bool              `json:"Enabled"`
	ChatPort        int               `json:"ChatPort"`
	StartedAt       string            `json:"StartedAt"`
	ActiveProfileID string            `json:"ActiveProfileID"`
	GameStatuses    map[string]string `json:"GameStatuses"`
}

func snapshotToWeb(snap engine.Snapshot) WebSnapshot {
	stgs := backendEngine.Settings()
	profile := stgs.ActiveProfile()
	gs := make(map[string]string, len(profile.GameStatuses))
	for game, status := range profile.GameStatuses {
		gs[string(game)] = string(status)
	}
	return WebSnapshot{
		Version:         buildinfo.Version,
		Platform:        runtime.GOOS,
		Phase:           string(snap.Phase),
		Detail:          snap.Detail,
		Game:            string(snap.Game),
		Status:          string(snap.Status),
		Enabled:         snap.Enabled,
		ChatPort:        snap.ChatPort,
		StartedAt:       snap.StartedAt.Format(time.RFC3339),
		ActiveProfileID: stgs.ActiveProfileID,
		GameStatuses:    gs,
	}
}

func originCheck(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			// Every local mutation is bounded, not only phone requests. This keeps
			// malformed imports or JSON payloads from consuming unbounded memory.
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		}
		if remoteRequest(r) {
			// Paired phones may only call the API from pages served by this
			// listener; any other web origin (including loopback origins
			// reached through the LAN listener) is rejected.
			origin := r.Header.Get("Origin")
			if origin != "" && !isSameOrigin(origin, r.Host) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && origin == "" {
				http.Error(w, "origin required", http.StatusForbidden)
				return
			}
			next(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" && !isLocalOrigin(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// isSameOrigin reports whether an Origin header matches the host that served
// the request. The LAN listener is intentionally HTTP-only until RiftOps can
// provision a certificate trusted by the phone.
func isSameOrigin(origin, host string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() == "" {
		return false
	}
	return strings.EqualFold(parsed.Host, host)
}

func isLocalOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() == "" {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

// httpError writes a user-safe error response and logs the original error.
// This avoids leaking internal details (file paths, URLs, stack traces) to the frontend.
func httpError(w http.ResponseWriter, msg string, code int) {
	http.Error(w, msg, code)
}

func launchBrowserApp(url string) error {
	switch runtime.GOOS {
	case "windows":
		paths := []string{
			os.Getenv("LocalAppData") + `\Google\Chrome\Application\chrome.exe`,
			os.Getenv("ProgramFiles") + `\Microsoft\Edge\Application\msedge.exe`,
			os.Getenv("ProgramFiles(x86)") + `\Microsoft\Edge\Application\msedge.exe`,
		}
		for _, path := range paths {
			if _, err := os.Stat(path); err == nil {
				cmd := exec.Command(path, fmt.Sprintf("--app=%s", url))
				return cmd.Start()
			}
		}
		cmd := exec.Command("cmd", "/c", "start", url)
		riotclient.HideWindow(cmd)
		return cmd.Start()
	case "darwin":
		cmd := exec.Command("open", "-a", "Google Chrome", "--args", fmt.Sprintf("--app=%s", url))
		if err := cmd.Run(); err == nil {
			return nil
		}
		cmd = exec.Command("open", url)
		return cmd.Start()
	default:
		cmd := exec.Command("xdg-open", url)
		return cmd.Start()
	}
}

func logFatalStartup(title, message string) {
	slog.Error("Startup Error", "title", title, "message", message)
	showStartupError(title, message)
}

// listenDashboard keeps 24080 as the stable/default port, but a stale process,
// another local development service, or a Windows excluded-port policy should
// not prevent RiftOps from opening. The final :0 fallback asks the OS for a
// free loopback port instead of guessing through a reserved range.
func listenDashboard() (net.Listener, int, error) {
	var lastErr error
	for candidate := preferredPort; candidate <= preferredPort+9; candidate++ {
		listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", candidate))
		if err == nil {
			return listener, candidate, nil
		}
		lastErr = err
	}
	if listener, err := net.Listen("tcp4", "127.0.0.1:0"); err == nil {
		selectedPort, ok := listener.Addr().(*net.TCPAddr)
		if ok && selectedPort.Port > 0 {
			return listener, selectedPort.Port, nil
		}
		_ = listener.Close()
		lastErr = fmt.Errorf("OS returned an invalid loopback port")
	} else {
		lastErr = fmt.Errorf("fixed ports and OS-assigned loopback port failed: %w", err)
	}
	return nil, 0, fmt.Errorf("dashboard ports %d-%d and OS-assigned loopback port are unavailable: %w", preferredPort, preferredPort+9, lastErr)
}

func dashboardPortPath(dataDir string) string {
	return filepath.Join(dataDir, portFileName)
}

func writeDashboardPort(dataDir string, selectedPort int) error {
	if selectedPort < 1 || selectedPort > 65535 {
		return fmt.Errorf("invalid dashboard port %d", selectedPort)
	}
	return os.WriteFile(dashboardPortPath(dataDir), []byte(strconv.Itoa(selectedPort)+"\n"), 0o600)
}

func readDashboardPort(dataDir string) int {
	raw, err := os.ReadFile(dashboardPortPath(dataDir))
	if err != nil || len(raw) > 32 {
		return preferredPort
	}
	selectedPort, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || selectedPort < 1 || selectedPort > 65535 {
		return preferredPort
	}
	return selectedPort
}

func shutdownHTTPServer() {
	remoteAccess.shutdown()
	if httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}
}

func notifyExistingInstance(dataDir string) {
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	instanceURL := fmt.Sprintf("http://127.0.0.1:%d", readDashboardPort(dataDir))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, instanceURL+"/api/show", nil)
	if err != nil {
		return
	}
	response, err := (&http.Client{Timeout: 1200 * time.Millisecond}).Do(request)
	if err == nil {
		_ = response.Body.Close()
	}
}

func main() {
	dataDir := flag.String("data", "", "data directory for profiles, settings and logs")
	noAutostart := flag.Bool("no-autostart", false, "skip autostart registry sync")
	flag.Parse()

	path := *dataDir
	if path == "" {
		if runtime.GOOS == "windows" {
			home, _ := os.UserHomeDir()
			path = filepath.Join(home, "AppData", "Local", "riftops")
		} else if configDir, configErr := os.UserConfigDir(); configErr == nil {
			path = filepath.Join(configDir, "RiftOps")
		} else {
			home, _ := os.UserHomeDir()
			path = filepath.Join(home, ".riftops")
		}
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		logFatalStartup("RiftOps could not create data directory", err.Error())
		return
	}
	_ = os.Chmod(path, 0o700)
	initReports(filepath.Join(path, "reports"))
	defer func() {
		if rec := recover(); rec != nil {
			writeReport("crash", fmt.Sprintf("panic in main: %v\n\n%s", rec, debug.Stack()))
			panic(rec)
		}
		markCleanExit("main returned normally")
	}()
	instance, err := singleinstance.Acquire(filepath.Join(path, "lock"))
	if err != nil {
		if errors.Is(err, singleinstance.ErrAlreadyRunning) {
			notifyExistingInstance(path)
			return
		}
		logFatalStartup("RiftOps could not start", err.Error())
		return
	}
	appLockInstance = instance
	defer instance.Close()

	logPath := filepath.Join(path, "debug.log")
	logger, logFile, err := diagnostics.OpenLogger(logPath)
	if err == nil {
		slog.SetDefault(logger)
		defer logFile.Close()
	}
	initRunMarker(path)
	slog.Info("RiftOps initialized", "dataDir", path, "reportsDir", reportDir, "logFile", logPath)

	backend, err := engine.New(settings.Store{Path: filepath.Join(path, "settings.json")})
	if err != nil {
		logFatalStartup("RiftOps could not load settings", err.Error())
		return
	}
	backendEngine = backend
	qolManager, err = qol.NewManager(filepath.Join(path, "qol.json"))
	if err != nil {
		slog.Warn("Could not load QoL preferences; using safe defaults", "error", err)
	}
	go qolManager.Run(context.Background())
	featureData, err = featurestore.New(filepath.Join(path, "features.json"))
	if err != nil {
		logFatalStartup("RiftOps could not load feature data", err.Error())
		return
	}

	broker.Start()

	if !*noAutostart && getAutostartEnabled() {
		_ = setAutostartEnabled(true)
	}

	go func() {
		for snap := range backendEngine.Events() {
			webSnap := snapshotToWeb(snap)
			broker.snapshots <- webSnap
			updateTrayStatus(snap)
		}
	}()

	mux := http.NewServeMux()
	dashboardMux.Store(mux)
	registerDashboardRoutes(mux)

	distFS, err := fs.Sub(frontendFS, "frontend/dist")
	if err != nil {
		slog.Error("Failed to load embedded frontend files", "error", err)
	} else {
		mux.Handle("/", http.FileServer(http.FS(distFS)))
	}

	httpServer = &http.Server{
		Handler:           recoveryMiddleware(remoteSecurityHeaders(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       20 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
		BaseContext: func(_ net.Listener) context.Context {
			return context.Background()
		},
	}
	listener, selectedPort, err := listenDashboard()
	if err != nil {
		logFatalStartup("RiftOps could not open its dashboard", err.Error())
		return
	}
	port = selectedPort
	clientURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	if err := writeDashboardPort(path, port); err != nil {
		slog.Warn("Could not persist dashboard port", "error", err)
	} else {
		defer os.Remove(dashboardPortPath(path))
	}
	go func() {
		slog.Info("Starting Web UI Server", "url", clientURL, "preferredPort", preferredPort, "port", port)
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("Failed to start web server", "error", err)
		}
	}()
	// Phone control is opt-in: the LAN listener only runs when the user has
	// enabled it, and it is started on demand from the dashboard afterwards.
	if backendEngine.Settings().PhoneAccess {
		startRemoteAccess(mux)
	}
	go startHangWatchdog()
	// The macOS host owns the native WebKit event loop so RiftOps appears as a
	// normal Dock application. Windows keeps its WebView2 window and tray flow.
	if runtime.GOOS == "darwin" {
		safeOpenDashboard(clientURL)
		markCleanExit("macOS window closed")
		return
	}

	safeOpenDashboard(clientURL)
	systray.Run(onTrayReady, onTrayExit)
}

func onTrayReady() {
	if len(appIco) > 0 {
		systray.SetIcon(appIco)
	} else if len(appPng) > 0 {
		systray.SetIcon(appPng)
	}
	systray.SetTitle("RiftOps")
	systray.SetTooltip("RiftOps Private Riot Client")

	mOpen := systray.AddMenuItem("Open RiftOps Dashboard", "Open client dashboard window")
	systray.AddSeparator()

	mPresence := systray.AddMenuItem("Presence Shield", "Change current presence")
	mOnline = mPresence.AddSubMenuItem("Online", "Appear online")
	mOffline = mPresence.AddSubMenuItem("Offline", "Appear offline")
	mMobile = mPresence.AddSubMenuItem("Mobile", "Appear mobile")

	mMasking = systray.AddMenuItem("Disable Masking", "Toggle masking status")
	mStop = systray.AddMenuItem("Stop RiftOps", "Shut down local tunnels and Riot clients")
	mStop.Disable()

	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit RiftOps", "Terminate server and close app")

	snap := backendEngine.Snapshot()
	updateTrayStatus(snap)

	go func() {
		for {
			select {
			case <-mOpen.ClickedCh:
				showWebViewWindow()
			case <-mOnline.ClickedCh:
				_ = backendEngine.SetStatus(context.Background(), model.StatusOnline)
			case <-mOffline.ClickedCh:
				_ = backendEngine.SetStatus(context.Background(), model.StatusOffline)
			case <-mMobile.ClickedCh:
				_ = backendEngine.SetStatus(context.Background(), model.StatusMobile)
			case <-mMasking.ClickedCh:
				currentSnap := backendEngine.Snapshot()
				_ = backendEngine.SetEnabled(context.Background(), !currentSnap.Enabled)
			case <-mStop.ClickedCh:
				backendEngine.Stop()
			case <-mQuit.ClickedCh:
				markCleanExit("Quit selected from the system tray")
				backendEngine.Stop()
				destroyWebView()
				shutdownHTTPServer()
				systray.Quit()
			}
		}
	}()
}

func onTrayExit() {
	if !gracefulExit.Load() {
		writeReport("unexpected-exit", "the system tray event loop exited without an explicit RiftOps quit request")
		clearRunMarker()
	}
	shutdownHTTPServer()
	os.Exit(0)
}

func updateTrayStatus(snap engine.Snapshot) {
	if mOnline == nil {
		return
	}
	if snap.Status == model.StatusOnline {
		mOnline.Check()
	} else {
		mOnline.Uncheck()
	}
	if snap.Status == model.StatusOffline || snap.Status == "" {
		mOffline.Check()
	} else {
		mOffline.Uncheck()
	}
	if snap.Status == model.StatusMobile {
		mMobile.Check()
	} else {
		mMobile.Uncheck()
	}
	if snap.Enabled {
		mMasking.Check()
		mMasking.SetTitle("Disable Masking")
	} else {
		mMasking.Uncheck()
		mMasking.SetTitle("Enable Masking")
	}
	if snap.Phase == engine.PhaseIdle || snap.Phase == engine.PhaseError {
		mStop.Disable()
	} else {
		mStop.Enable()
	}
}

func getSnapshot(w http.ResponseWriter, r *http.Request) {
	snap := backendEngine.Snapshot()
	webSnap := snapshotToWeb(snap)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(webSnap)
}

func sseHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE unsupported", http.StatusInternalServerError)
		return
	}

	messageChan := make(chan WebSnapshot)
	broker.newClients <- messageChan

	initData, _ := json.Marshal(snapshotToWeb(backendEngine.Snapshot()))
	_, _ = fmt.Fprintf(w, "data: %s\n\n", string(initData))
	flusher.Flush()

	defer func() { broker.defClients <- messageChan }()

	for {
		select {
		case <-r.Context().Done():
			return
		case snap := <-messageChan:
			data, _ := json.Marshal(snap)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", string(data))
			flusher.Flush()
		}
	}
}

func getProfiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(backendEngine.LaunchProfiles())
}

func getProfileSessionStatuses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type profileSessionStatus struct {
		Saved      bool   `json:"saved"`
		Expired    bool   `json:"expired"`
		CapturedAt string `json:"capturedAt,omitempty"`
		ExpiresAt  string `json:"expiresAt,omitempty"`
		Error      string `json:"error,omitempty"`
	}
	statuses := make(map[string]profileSessionStatus)
	for _, profile := range backendEngine.LaunchProfiles() {
		status, err := backendEngine.SavedLoginStatusForProfile(profile.ID)
		entry := profileSessionStatus{Saved: err == nil, Expired: errors.Is(err, sessionvault.ErrExpired)}
		if err == nil || errors.Is(err, sessionvault.ErrExpired) {
			entry.CapturedAt = status.CapturedAt.Format(time.RFC3339)
			entry.ExpiresAt = status.ExpiresAt.Format(time.RFC3339)
		} else if !errors.Is(err, sessionvault.ErrNotFound) {
			entry.Error = err.Error()
		}
		statuses[profile.ID] = entry
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(statuses)
}

func selectProfile(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("selectProfile decode", "error", err)
		return
	}
	if snap := backendEngine.Snapshot(); snap.Phase != engine.PhaseIdle && snap.Phase != engine.PhaseError {
		backendEngine.Stop()
	}
	if err := backendEngine.SelectLaunchProfile(body.ID); err != nil {
		httpError(w, "Failed to select profile", http.StatusInternalServerError)
		slog.Error("selectProfile", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func switchProfile(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("switchProfile decode", "error", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	result, err := backendEngine.SwitchLaunchProfile(ctx, body.ID, 30*24*time.Hour)
	if err != nil {
		httpError(w, "Failed to switch profile", http.StatusInternalServerError)
		slog.Error("switchProfile", "error", err)
		return
	}
	profile := result.Profile
	game := profile.DefaultGame
	status := profile.Status
	if profile.GameStatuses != nil {
		if override, ok := profile.GameStatuses[game]; ok && override.Valid() {
			status = override
		}
	}
	go func() {
		_ = backendEngine.Run(context.Background(), engine.RunOptions{
			Game:           game,
			Status:         status,
			Patchline:      profile.Patchline,
			StopExisting:   false,
			FreshLogin:     !result.TargetSessionAvailable,
			RiotClientArgs: append([]string(nil), profile.RiotClientArgs...),
			GameArgs:       launchGameArgs(profile),
		})
	}()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"profile":                profile,
		"refreshedCurrent":       result.RefreshedCurrent,
		"targetSessionAvailable": result.TargetSessionAvailable,
		"targetSessionExpired":   result.TargetSessionExpired,
	})
}

func saveProfile(w http.ResponseWriter, r *http.Request) {
	var profile settings.LaunchProfile
	if err := json.NewDecoder(r.Body).Decode(&profile); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("saveProfile decode", "error", err)
		return
	}
	isNew := profile.ID == ""
	if isNew {
		profile.ID = settings.NewProfileID()
	}
	switch strings.ToLower(strings.TrimSpace(string(profile.StartupStatus))) {
	case "online", "chat":
		profile.StartupStatus = "chat"
	case "offline":
		profile.StartupStatus = "offline"
	case "mobile":
		profile.StartupStatus = "mobile"
	default:
		profile.StartupStatus = settings.StartupLast
	}
	switch strings.ToLower(strings.TrimSpace(string(profile.Status))) {
	case "online":
		profile.Status = model.StatusOnline
	case "offline":
		profile.Status = model.StatusOffline
	case "mobile":
		profile.Status = model.StatusMobile
	}
	if err := backendEngine.SaveLaunchProfile(profile); err != nil {
		httpError(w, "Failed to save profile", http.StatusInternalServerError)
		slog.Error("saveProfile", "error", err)
		return
	}
	if isNew {
		if err := backendEngine.SelectLaunchProfile(profile.ID); err != nil {
			httpError(w, "Profile was saved but could not be activated", http.StatusInternalServerError)
			slog.Error("saveProfile select", "profile", profile.ID, "error", err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(profile)
}

func deleteProfile(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("deleteProfile decode", "error", err)
		return
	}
	if err := backendEngine.DeleteLaunchProfile(body.ID); err != nil {
		httpError(w, "Failed to delete profile", http.StatusInternalServerError)
		slog.Error("deleteProfile", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func exportProfiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(backendEngine.ExportProfiles())
}

func importProfiles(w http.ResponseWriter, r *http.Request) {
	var profiles []settings.LaunchProfile
	if err := json.NewDecoder(r.Body).Decode(&profiles); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("importProfiles decode", "error", err)
		return
	}
	if len(profiles) == 0 {
		httpError(w, "No profiles to import", http.StatusBadRequest)
		return
	}
	if err := backendEngine.ImportProfiles(profiles); err != nil {
		httpError(w, "Failed to import profiles", http.StatusInternalServerError)
		slog.Error("importProfiles", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func savePreferences(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Game          string `json:"game"`
		StartupStatus string `json:"startupStatus"`
		ConnectToMUC  bool   `json:"connectToMUC"`
		CheckUpdates  bool   `json:"checkUpdates"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("savePreferences decode", "error", err)
		return
	}
	game := model.Game(strings.ToLower(strings.ReplaceAll(body.Game, " ", "")))
	if game == "leagueoflegends" {
		game = model.GameLeague
	} else if game == "riotclient" {
		game = model.GameRiotClient
	}
	var startup settings.StartupStatus
	switch body.StartupStatus {
	case "online", "chat":
		startup = "chat"
	case "offline":
		startup = "offline"
	case "mobile":
		startup = "mobile"
	default:
		startup = settings.StartupLast
	}
	if err := backendEngine.SavePreferences(game, startup, body.ConnectToMUC, body.CheckUpdates); err != nil {
		httpError(w, "Failed to save preferences", http.StatusInternalServerError)
		slog.Error("savePreferences", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func getPreferences(w http.ResponseWriter, r *http.Request) {
	prefs := backendEngine.Settings()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"game":           prefs.DefaultGame,
		"startupStatus":  prefs.StartupStatus,
		"connectToMUC":   prefs.ConnectToMUC,
		"checkUpdates":   prefs.CheckUpdates,
		"riotClientPath": prefs.RiotClientPath,
	})
}

// diagnosticsReportsHandler lists saved crash/hang reports, newest first.
func diagnosticsReportsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type reportFile struct {
		Name     string `json:"name"`
		Size     int64  `json:"size"`
		Modified string `json:"modified"`
	}
	entries, err := os.ReadDir(reportDir)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]reportFile{})
		return
	}
	reports := make([]reportFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".txt" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		reports = append(reports, reportFile{Name: entry.Name(), Size: info.Size(), Modified: info.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].Name > reports[j].Name })
	if len(reports) > maxSavedReports {
		reports = reports[:maxSavedReports]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(reports)
}

func writeRiotClientLocation(w http.ResponseWriter, path, source string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"path":   path,
		"source": source,
	})
}

func riotClientLocationHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		configured := backendEngine.Settings().RiotClientPath
		if configured != "" {
			writeRiotClientLocation(w, configured, "configured")
			return
		}
		executable, err := backendEngine.ResolveRiotClientExecutable()
		if err != nil {
			writeRiotClientLocation(w, "", "not-found")
			return
		}
		writeRiotClientLocation(w, executable, "detected")
	case http.MethodPost:
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpError(w, "Enter a valid Riot Client or League application location", http.StatusBadRequest)
			return
		}
		resolved, err := backendEngine.SaveRiotClientPath(body.Path)
		if err != nil {
			httpError(w, "No launchable Riot Client was found at that location", http.StatusUnprocessableEntity)
			slog.Info("manual Riot Client location rejected", "error", err)
			return
		}
		writeRiotClientLocation(w, resolved, "configured")
	case http.MethodDelete:
		if _, err := backendEngine.SaveRiotClientPath(""); err != nil {
			httpError(w, "Could not clear the saved Riot Client location", http.StatusInternalServerError)
			return
		}
		writeRiotClientLocation(w, "", "automatic")
	default:
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func detectRiotClientLocation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	executable, err := platform.New().DiscoverRiotClient()
	if err != nil {
		httpError(w, "Riot Client was not found automatically. Use Browse or enter the application path.", http.StatusNotFound)
		return
	}
	resolved, err := backendEngine.SaveRiotClientPath(executable)
	if err != nil {
		httpError(w, "The detected Riot Client location could not be saved", http.StatusInternalServerError)
		return
	}
	writeRiotClientLocation(w, resolved, "detected")
}

func browseRiotClientLocation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if runtime.GOOS != "darwin" {
		httpError(w, "Native application browsing is currently available on macOS", http.StatusNotImplemented)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	script := `POSIX path of (choose file with prompt "Select Riot Client or League of Legends" of type {"com.apple.application-bundle"})`
	output, err := exec.CommandContext(ctx, "osascript", "-e", script).CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "-128") {
			httpError(w, "Selection cancelled", http.StatusConflict)
			return
		}
		httpError(w, "The macOS application picker could not select Riot Client", http.StatusInternalServerError)
		slog.Info("macOS Riot Client picker failed", "error", err)
		return
	}
	resolved, err := backendEngine.SaveRiotClientPath(strings.TrimSpace(string(output)))
	if err != nil {
		httpError(w, "The selected application does not contain RiotClientServices or LeagueClient", http.StatusUnprocessableEntity)
		slog.Info("selected macOS Riot Client location rejected", "error", err)
		return
	}
	writeRiotClientLocation(w, resolved, "browse")
}

func setEnabled(w http.ResponseWriter, r *http.Request) {
	var body struct{ Enabled bool }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("setEnabled decode", "error", err)
		return
	}
	if err := backendEngine.SetEnabled(r.Context(), body.Enabled); err != nil {
		httpError(w, "Failed to update masking status", http.StatusInternalServerError)
		slog.Error("setEnabled", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func setStatus(w http.ResponseWriter, r *http.Request) {
	var body struct{ Status string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("setStatus decode", "error", err)
		return
	}
	var stat model.Status
	switch body.Status {
	case "online":
		stat = model.StatusOnline
	case "mobile":
		stat = model.StatusMobile
	default:
		stat = model.StatusOffline
	}
	if err := backendEngine.SetStatus(r.Context(), stat); err != nil {
		httpError(w, "Failed to update status", http.StatusInternalServerError)
		slog.Error("setStatus", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func startEngine(w http.ResponseWriter, r *http.Request) {
	var body struct {
		StopExisting bool   `json:"stopExisting"`
		Game         string `json:"game"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("startEngine decode", "error", err)
		return
	}
	profile := backendEngine.ActiveLaunchProfile()
	game := profile.DefaultGame
	if body.Game != "" {
		parsed, err := model.ParseGame(strings.ToLower(strings.TrimSpace(body.Game)))
		if err != nil || parsed == model.GameAuto || parsed == model.GamePrompt {
			httpError(w, "Select a supported game before launching", http.StatusBadRequest)
			return
		}
		game = parsed
	}
	if _, err := backendEngine.ResolveRiotClientExecutable(); err != nil {
		httpError(w, "Riot Client was not found. Open Settings, then locate Riot Client or League of Legends.", http.StatusUnprocessableEntity)
		slog.Info("launch preflight could not resolve Riot Client", "error", err)
		return
	}
	if !body.StopExisting {
		adapter := platform.New()
		processes, err := adapter.KnownProcesses(r.Context())
		if err == nil && len(processes) > 0 {
			httpError(w, "Riot Client is already running. Restart it with RiftOps to apply the launch profile.", http.StatusConflict)
			return
		}
	}
	go func() {
		_ = backendEngine.Run(context.Background(), engine.RunOptions{
			Game:           game,
			Status:         profile.Status,
			Patchline:      profile.Patchline,
			StopExisting:   body.StopExisting,
			RiotClientArgs: append([]string(nil), profile.RiotClientArgs...),
			GameArgs:       launchGameArgs(profile),
		})
	}()
	w.WriteHeader(http.StatusOK)
}

// launchGameArgs appends only the validated, Riot-supported locale flag. The
// app never patches League files or accepts free-form locale arguments.
func launchGameArgs(profile settings.LaunchProfile) []string {
	// Keep the dedicated profile locale as the single source of truth. Older
	// profiles may still contain a free-form --locale argument in GameArgs;
	// remove both --locale=value and the two-token form before appending the
	// validated value below so Riot never receives conflicting locales.
	args := make([]string, 0, len(profile.GameArgs)+1)
	for index := 0; index < len(profile.GameArgs); index++ {
		argument := profile.GameArgs[index]
		lower := strings.ToLower(strings.TrimSpace(argument))
		if lower == "--locale" {
			if index+1 < len(profile.GameArgs) {
				index++
			}
			continue
		}
		if strings.HasPrefix(lower, "--locale=") {
			continue
		}
		args = append(args, argument)
	}
	if locale := strings.TrimSpace(profile.LeagueLocale); locale != "" && locale != settings.DefaultLeagueLocale {
		args = append(args, "--locale="+locale)
	}
	return args
}

func stopEngine(w http.ResponseWriter, r *http.Request) {
	backendEngine.Stop()
	w.WriteHeader(http.StatusOK)
}

// Saved Riot login profile endpoints.
func captureSession(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := backendEngine.CaptureSavedLogin(ctx, 30*24*time.Hour); err != nil {
		httpError(w, "Could not save this Riot session. Keep Riot Client open with Stay signed in enabled, then try again.", http.StatusInternalServerError)
		slog.Error("captureSession", "error", err)
		return
	}
	profile := backendEngine.ActiveLaunchProfile()
	slog.Info("saved Riot remembered login", "profile", profile.Name, "profileID", profile.ID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"profileId": profile.ID, "profileName": profile.Name})
}

func forgetSession(w http.ResponseWriter, r *http.Request) {
	if err := backendEngine.ForgetSavedLogin(); err != nil {
		httpError(w, "Failed to forget saved login", http.StatusInternalServerError)
		slog.Error("forgetSession", "error", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func getSessionStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	active, activeErr := backendEngine.RiotSessionActive(ctx)
	cancel()

	status, err := backendEngine.SavedLoginStatus()
	profile := backendEngine.ActiveLaunchProfile()
	saved := err == nil
	var expires string
	var capturedAt string
	if saved {
		expires = time.Until(status.ExpiresAt).Round(time.Hour).String()
		capturedAt = status.CapturedAt.Format(time.RFC3339)
	}
	var errMsg string
	if err != nil && !errors.Is(err, sessionvault.ErrNotFound) && !errors.Is(err, sessionvault.ErrExpired) {
		errMsg = err.Error()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"active":          activeErr == nil && active,
		"saved":           saved,
		"expiresIn":       expires,
		"capturedAt":      capturedAt,
		"activeProfileId": profile.ID,
		"profileName":     profile.Name,
		"error":           errMsg,
	})
}

var (
	updateCacheMu     sync.Mutex
	cachedRelease     update.Release
	cachedReleaseTime time.Time
)

func checkUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	manual := r.URL.Query().Get("manual") == "1" || r.URL.Query().Get("manual") == "true"
	prefs := backendEngine.Settings()
	if !manual && !prefs.CheckUpdates {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"available": false})
		return
	}

	updateCacheMu.Lock()
	release := cachedRelease
	useCache := !manual && !cachedReleaseTime.IsZero() && time.Since(cachedReleaseTime) < 5*time.Minute
	updateCacheMu.Unlock()

	var err error
	if !useCache {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		release, err = (update.Checker{}).Latest(ctx)
		if err == nil {
			updateCacheMu.Lock()
			cachedRelease = release
			cachedReleaseTime = time.Now()
			updateCacheMu.Unlock()
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		if manual {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"available": false,
				"error":     "Could not connect to GitHub release service",
			})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"available": false})
		}
		return
	}

	// For automated checks, do not prompt if the user previously chose to skip this specific version
	if !manual && release.Version == prefs.PromptedUpdate {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"available":      false,
			"skipped":        true,
			"currentVersion": buildinfo.Version,
			"latestVersion":  release.Version,
		})
		return
	}

	newer, err := update.IsNewer(buildinfo.Version, release.Version)
	if err != nil || !newer {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"available":      false,
			"currentVersion": buildinfo.Version,
			"latestVersion":  release.Version,
		})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"available":      true,
		"currentVersion": buildinfo.Version,
		"release": map[string]interface{}{
			"version":            release.Version,
			"url":                release.URL,
			"name":               release.Name,
			"notes":              release.Notes,
			"checksumAvailable":  release.ChecksumAvailable,
			"signatureStatus":    release.SignatureStatus,
			"downloadAssetNames": release.DownloadAssetNames,
		},
	})
}

func skipUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Version string `json:"version"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid update version", http.StatusBadRequest)
		return
	}
	body.Version = strings.TrimSpace(body.Version)
	newer, err := update.IsNewer(buildinfo.Version, body.Version)
	if err != nil || !newer {
		httpError(w, "Invalid update version", http.StatusBadRequest)
		return
	}
	if err := backendEngine.MarkUpdatePrompted(body.Version); err != nil {
		httpError(w, "Could not save skipped version", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func showApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	showWebViewWindow()
	w.WriteHeader(http.StatusNoContent)
}

func quitApp(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusAccepted)
	go func() {
		time.Sleep(50 * time.Millisecond)
		markCleanExit("Quit requested from the app")
		backendEngine.Stop()
		destroyWebView()
		shutdownHTTPServer()
		systray.Quit()
	}()
}

func windowMinimizeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	windowMinimize()
	w.WriteHeader(http.StatusNoContent)
}

func windowMaximizeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	windowToggleMaximize()
	w.WriteHeader(http.StatusNoContent)
}

func windowCloseHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	windowClose()
	w.WriteHeader(http.StatusNoContent)
}

func windowStateHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{
		"maximized": windowIsMaximized(),
	})
}

func setAutostart(w http.ResponseWriter, r *http.Request) {
	var body struct{ Enabled bool }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		slog.Debug("setAutostart decode", "error", err)
		return
	}
	if err := setAutostartEnabled(body.Enabled); err != nil {
		httpError(w, "Failed to set autostart", http.StatusInternalServerError)
		slog.Error("setAutostart", "error", err)
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"enabled": body.Enabled})
}

func getAutostart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"enabled": getAutostartEnabled()})
}

// ---------------------------------------------------------------------------
// Riot Dev API Handlers
// ---------------------------------------------------------------------------

func riotConfiguredHandler(w http.ResponseWriter, r *http.Request) {
	source := riotapi.AuthSource()
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"configured": riotapi.IsConfigured(),
		"authSource": source,
	})
}

func riotAccountHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	gameName := r.URL.Query().Get("gameName")
	tagLine := r.URL.Query().Get("tagLine")
	if gameName == "" || tagLine == "" {
		httpError(w, "gameName and tagLine required", http.StatusBadRequest)
		return
	}
	account, err := riotapi.GetAccountByRiotID(region, gameName, tagLine)
	if err != nil {
		httpError(w, "Failed to fetch Riot account", http.StatusInternalServerError)
		slog.Error("riotAccountHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(account)
}

func riotSummonerHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	puuid := r.URL.Query().Get("puuid")
	if puuid == "" {
		httpError(w, "puuid required", http.StatusBadRequest)
		return
	}
	summoner, err := riotapi.GetSummonerByPUUID(region, puuid)
	if err != nil {
		httpError(w, "Failed to fetch summoner", http.StatusInternalServerError)
		slog.Error("riotSummonerHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(summoner)
}

func riotMasteryHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	puuid := r.URL.Query().Get("puuid")
	if puuid == "" {
		httpError(w, "puuid required", http.StatusBadRequest)
		return
	}
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	if count <= 0 {
		count = 6
	}
	mastery, err := riotapi.GetChampionMastery(region, puuid, count)
	if err != nil {
		httpError(w, "Failed to fetch champion mastery", http.StatusInternalServerError)
		slog.Error("riotMasteryHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(mastery)
}

func riotLeagueHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	summonerID := r.URL.Query().Get("summonerId")
	if summonerID == "" {
		httpError(w, "summonerId required", http.StatusBadRequest)
		return
	}
	entries, err := riotapi.GetLeagueEntries(region, summonerID)
	if err != nil {
		httpError(w, "Failed to fetch league entries", http.StatusInternalServerError)
		slog.Error("riotLeagueHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(entries)
}

func riotCurrentGameHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	puuid := r.URL.Query().Get("puuid")
	if puuid == "" {
		httpError(w, "puuid required", http.StatusBadRequest)
		return
	}
	game, err := riotapi.GetCurrentGame(region, puuid)
	if err != nil {
		httpError(w, "Failed to fetch current game", http.StatusInternalServerError)
		slog.Error("riotCurrentGameHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(game)
}

func riotMatchIDsHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	puuid := strings.TrimSpace(r.URL.Query().Get("puuid"))
	if puuid == "" {
		httpError(w, "puuid required", http.StatusBadRequest)
		return
	}
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	ids, err := riotapi.GetMatchIDs(region, puuid, start, count)
	if err != nil {
		httpError(w, "Failed to fetch Riot match IDs", http.StatusBadGateway)
		slog.Error("riotMatchIDsHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"source": "riot-api", "matchIds": ids, "start": max(0, start), "count": len(ids)})
}

func riotMatchHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	matchID := strings.TrimSpace(r.URL.Query().Get("matchId"))
	if matchID == "" {
		httpError(w, "matchId required", http.StatusBadRequest)
		return
	}
	match, err := riotapi.GetMatch(region, matchID)
	if err != nil {
		httpError(w, "Failed to fetch Riot match", http.StatusBadGateway)
		slog.Error("riotMatchHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(match)
}

func riotMatchTimelineHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	matchID := strings.TrimSpace(r.URL.Query().Get("matchId"))
	if matchID == "" {
		httpError(w, "matchId required", http.StatusBadRequest)
		return
	}
	timeline, err := riotapi.GetMatchTimeline(region, matchID)
	if err != nil {
		httpError(w, "Failed to fetch Riot match timeline", http.StatusBadGateway)
		slog.Error("riotMatchTimelineHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(timeline)
}

func riotStatusHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	if region == "" {
		region = "EUW"
	}
	status, err := riotapi.GetRegionStatus(region)
	if err != nil {
		httpError(w, "Failed to fetch region status", http.StatusInternalServerError)
		slog.Error("riotStatusHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(status)
}

// ---------------------------------------------------------------------------
// Data Dragon Handlers
// ---------------------------------------------------------------------------

func ddragonVersionHandler(w http.ResponseWriter, r *http.Request) {
	ver, err := riotapi.GetLatestDDragonVersion()
	if err != nil {
		httpError(w, "Failed to fetch Data Dragon version", http.StatusInternalServerError)
		slog.Error("ddragonVersionHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"version": ver})
}

func ddragonChampionsHandler(w http.ResponseWriter, r *http.Request) {
	champions, err := riotapi.GetChampions()
	if err != nil {
		httpError(w, "Failed to fetch champions", http.StatusInternalServerError)
		slog.Error("ddragonChampionsHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(champions)
}

func ddragonProfileIconsHandler(w http.ResponseWriter, r *http.Request) {
	icons, err := riotapi.GetProfileIcons()
	if err != nil {
		httpError(w, "Failed to fetch profile icons", http.StatusInternalServerError)
		slog.Error("ddragonProfileIconsHandler", "error", err)
		return
	}
	_ = json.NewEncoder(w).Encode(icons)
}

// ─────────────────────────────────────────────────────────────────────────────
// LCU (local client) Handlers
// ─────────────────────────────────────────────────────────────────────────────

type lcuOverviewResponse struct {
	Status struct {
		Connected   bool   `json:"connected"`
		LeagueReady bool   `json:"leagueReady"`
		AuthSource  string `json:"authSource"`
		Detail      string `json:"detail,omitempty"`
	} `json:"status"`
	Health struct {
		Connected  bool    `json:"connected"`
		LatencyMS  int64   `json:"latencyMs"`
		Uptime     int64   `json:"uptime"`
		MemoryMB   int64   `json:"memoryMB"`
		CPUPercent float64 `json:"cpuPercent"`
	} `json:"health"`
	QoL *riotclient.QoLState `json:"qol,omitempty"`
	// Session is the raw LCU gameflow session when League is loading or in a
	// match. It is deliberately kept optional: the endpoint is not available
	// in every phase, and the UI must never invent live-game details.
	Session          json.RawMessage `json:"gameflowSession,omitempty"`
	SessionAvailable *bool           `json:"gameflowSessionAvailable,omitempty"`
	// ActiveGame is sourced from the documented read-only Game Client Data API
	// when League is loading or in a match. It is optional because that API is
	// only listening after the game client has started.
	ActiveGame          *riotclient.GameClientData `json:"activeGame,omitempty"`
	ActiveGameAvailable *bool                      `json:"activeGameAvailable,omitempty"`
}

// lcuOverviewHandler serves the frequently refreshed client state in one
// request. This replaces three overlapping frontend polls and reuses the same
// lockfile/phase read for status, health, and QoL.
func lcuOverviewHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	response := lcuOverviewResponse{}
	response.Status.AuthSource = "none"

	lf := riotclient.GetLCULockfile()
	if lf == nil {
		response.Status.Detail = "Open Riot Client and sign in to connect RiftOps."
		_ = json.NewEncoder(w).Encode(response)
		return
	}

	response.Status.Connected = true
	if lf.Source == "league" {
		response.Status.AuthSource = "lcu"
	} else {
		response.Status.AuthSource = "riot-client"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	started := time.Now()
	phase, err := lf.GetGameflowPhase(ctx)
	response.Health.LatencyMS = time.Since(started).Milliseconds()
	if err != nil {
		response.Health.LatencyMS = 0
		response.Status.Detail = "Riot Client is open; waiting for the League home screen."
		_ = json.NewEncoder(w).Encode(response)
		return
	}

	response.Status.LeagueReady = true
	response.Health.Connected = true
	state := lf.FetchQoLStateWithPhase(ctx, phase)
	response.QoL = &state
	if phase == "GameStart" || phase == "Loading" || phase == "InProgress" || phase == "Reconnect" || phase == "EndOfGame" {
		available := false
		if sessionBody, sessionErr := lf.DoRequest(ctx, http.MethodGet, "/lol-gameflow/v1/session"); sessionErr == nil && json.Valid(sessionBody) {
			available = true
			response.Session = json.RawMessage(sessionBody)
			var session struct {
				GameData struct {
					IsCustom bool   `json:"isCustom"`
					QueueID  int    `json:"queueId"`
					GameMode string `json:"gameMode"`
				} `json:"gameData"`
			}
			if json.Unmarshal(sessionBody, &session) == nil {
				state.QueueID = session.GameData.QueueID
				state.IsCustom = state.IsCustom || session.GameData.IsCustom || session.GameData.QueueID == riotclient.PracticeToolQueueID || strings.EqualFold(session.GameData.GameMode, "PRACTICETOOL")
			}
		}
		response.SessionAvailable = &available
		activeGameAvailable := false
		if activeGame, activeGameErr := riotclient.FetchActiveGame(ctx); activeGameErr == nil && activeGame != nil && activeGame.Available {
			activeGameAvailable = true
			response.ActiveGame = activeGame
		}
		response.ActiveGameAvailable = &activeGameAvailable
	}
	process := riotclient.GetLeagueProcessInfo()
	response.Health.Uptime = process.UptimeSec
	response.Health.MemoryMB = process.MemoryMB
	response.Health.CPUPercent = process.CPUPercent
	_ = json.NewEncoder(w).Encode(response)
}

// lcuActiveGameHandler exposes the same normalized read-only game snapshot as
// the overview endpoint for clients that need a direct refresh (for example a
// phone opening the Live Session page after a backgrounded tab resumes).
func lcuActiveGameHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	ctx, cancel := context.WithTimeout(r.Context(), 1200*time.Millisecond)
	defer cancel()
	activeGame, err := riotclient.FetchActiveGame(ctx)
	if err != nil || activeGame == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"available": false,
			"detail":    "The League game client is not serving live data yet.",
		})
		return
	}
	_ = json.NewEncoder(w).Encode(activeGame)
}

func lcuStatusHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	lf := riotclient.GetLCULockfile()
	connected := lf != nil
	source := "none"
	detail := ""
	leagueReady := false

	if connected {
		if lf.Source == "league" {
			source = "lcu"
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			_, err := lf.DoRequest(ctx, "GET", "/lol-gameflow/v1/gameflow-phase")
			leagueReady = err == nil
			if !leagueReady {
				detail = "League lockfile was found but its API is not responding yet."
			}
		} else {
			source = "riot-client"
			// Check if League LCU endpoints respond anyway
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			_, err := lf.DoRequest(ctx, "GET", "/lol-summoner/v1/current-summoner")
			if err == nil {
				leagueReady = true
			}
		}
	} else {
		detail = checkLcuPaths()
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"connected":   connected,
		"leagueReady": leagueReady,
		"authSource":  source,
		"detail":      detail,
	})
}

// checkLcuPaths examines known lockfile locations and returns diagnostic info.
func checkLcuPaths() string {
	bases := riotclient.LockfileSearchBases()
	rels := riotclient.LockfileSearchPaths()
	var found []string
	var missing []string
	for _, base := range bases {
		if base == "" {
			continue
		}
		for _, rel := range rels {
			path := filepath.Join(base, rel)
			if _, err := os.Stat(path); err == nil {
				found = append(found, path)
			} else {
				missing = append(missing, path)
			}
		}
	}
	if len(found) > 0 {
		return fmt.Sprintf("Found lockfile at %s but parse failed", strings.Join(found, ", "))
	}
	return fmt.Sprintf("No lockfile found. Checked: %s", strings.Join(missing, ", "))
}

func lcuProfileHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected — launch Riot Client first", http.StatusServiceUnavailable)
		return
	}
	profile, err := lf.FetchLCUProfile(r.Context())
	if err != nil {
		httpError(w, "Failed to fetch LCU profile", http.StatusInternalServerError)
		slog.Error("lcuProfileHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(profile)
}

func lcuLaunchLeagueHandler(w http.ResponseWriter, r *http.Request) {
	if err := riotclient.LaunchLeague(r.Context()); err != nil {
		httpError(w, "Failed to launch League of Legends", http.StatusInternalServerError)
		slog.Error("lcuLaunchLeagueHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"launched": true})
}

func lcuMatchHistoryHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected — launch League of Legends first", http.StatusServiceUnavailable)
		return
	}
	begin, err := strconv.Atoi(r.URL.Query().Get("begin"))
	if err != nil || begin < 0 {
		begin = 0
	}
	end, err := strconv.Atoi(r.URL.Query().Get("end"))
	if err != nil || end <= begin {
		end = begin + 50
	}
	if end-begin > 50 {
		end = begin + 50
	}
	body, err := lf.FetchLCUMatchHistory(r.Context(), begin, end)
	if err != nil {
		httpError(w, "Failed to fetch match history", http.StatusInternalServerError)
		slog.Error("lcuMatchHistoryHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuGameDetailHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	gameIDStr := r.URL.Query().Get("gameId")
	if gameIDStr == "" {
		httpError(w, "missing gameId param", http.StatusBadRequest)
		return
	}
	var gameID int64
	if _, err := fmt.Sscanf(gameIDStr, "%d", &gameID); err != nil {
		httpError(w, "invalid gameId", http.StatusBadRequest)
		return
	}
	body, err := lf.FetchLCUGameDetail(r.Context(), gameID)
	if err != nil {
		httpError(w, "Failed to fetch game detail", http.StatusInternalServerError)
		slog.Error("lcuGameDetailHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuSkinsHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected — launch League of Legends first", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchLCUSkins(r.Context())
	if err != nil {
		httpError(w, "Failed to fetch skin inventory", http.StatusInternalServerError)
		slog.Error("lcuSkinsHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuBackgroundChampionsHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected — launch League of Legends first", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchLCUChampions(r.Context())
	if err != nil {
		httpError(w, "Failed to fetch champion catalogue", http.StatusInternalServerError)
		slog.Error("lcuBackgroundChampionsHandler", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuBackgroundSkinsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	championID, err := strconv.Atoi(r.URL.Query().Get("championId"))
	if err != nil || championID <= 0 {
		httpError(w, "championId must be a positive integer", http.StatusBadRequest)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected — launch League of Legends first", http.StatusServiceUnavailable)
		return
	}
	inventory, err := lf.FetchLCUChampionSkins(r.Context(), championID)
	if err != nil {
		httpError(w, "Failed to fetch champion skins", http.StatusInternalServerError)
		slog.Error("lcuBackgroundSkinsHandler", "championID", championID, "error", err)
		return
	}
	catalogue, catalogueErr := lf.DoRequest(r.Context(), http.MethodGet, "/lol-game-data/assets/v1/skins.json")
	if catalogueErr != nil {
		// Inventory metadata can still contain real asset paths. Never guess a
		// filename when the static catalogue is unavailable.
		slog.Debug("skin asset catalogue unavailable", "error", catalogueErr)
		catalogue = nil
	}
	skins, err := buildProfileBackgroundSkins(inventory, catalogue)
	if err != nil {
		httpError(w, "Failed to read champion skin metadata", http.StatusInternalServerError)
		slog.Error("lcuBackgroundSkinsHandler metadata", "championID", championID, "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(skins)
}

func requireLCUPhase(w http.ResponseWriter, r *http.Request, lf *riotclient.Lockfile, allowed ...string) bool {
	phase, err := lf.GetGameflowPhase(r.Context())
	if err != nil {
		httpError(w, "Could not determine the current League client phase", http.StatusServiceUnavailable)
		return false
	}
	for _, expected := range allowed {
		if phase == expected {
			return true
		}
	}
	httpError(w, "This action is only available during: "+strings.Join(allowed, ", ")+" (current phase: "+phase+")", http.StatusConflict)
	return false
}

func lcuAutoAcceptHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "ReadyCheck") {
		return
	}
	if err := lf.AcceptReadyCheck(r.Context()); err != nil {
		httpError(w, "Failed to accept ready check", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"accepted": true})
}

func lcuDeclineReadyHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "ReadyCheck") {
		return
	}
	if err := lf.DeclineReadyCheck(r.Context()); err != nil {
		httpError(w, "Failed to decline ready check", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"declined": true})
}

func lcuAutoRequeueHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "Lobby") {
		return
	}
	if err := lf.AutoRequeue(r.Context()); err != nil {
		httpError(w, "Failed to start matchmaking", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"requeued": true})
}

func lcuStopQueueHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "Matchmaking") {
		return
	}
	if err := lf.StopQueue(r.Context()); err != nil {
		httpError(w, "Failed to stop matchmaking", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"stopped": true})
}

func lcuQuitCustomHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	phase, err := lf.GetGameflowPhase(r.Context())
	if err != nil {
		httpError(w, "Could not determine the current League phase", http.StatusServiceUnavailable)
		return
	}
	if phase != "Lobby" && phase != "Matchmaking" && phase != "ChampSelect" && phase != "GameStart" && phase != "Loading" && phase != "InProgress" && phase != "Reconnect" {
		httpError(w, "Quit is only available for an active custom or practice session", http.StatusConflict)
		return
	}
	if err := lf.QuitCustomSession(r.Context(), phase); err != nil {
		httpError(w, "Failed to leave the custom or practice session", http.StatusBadGateway)
		slog.Info("custom session quit failed", "phase", phase, "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"quit": true})
}

func lcuAvailableQueuesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchAvailableQueues(r.Context())
	if err != nil {
		httpError(w, "Game modes are unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// lcuCreateLobbyHandler opens a lobby for a game-mode queue, or a Practice
// Tool session when practiceTool is set. Practice Tool is intended for safe
// testing of the pick/ban automation without touching real matchmaking.
func lcuCreateLobbyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		QueueID      int    `json:"queueId"`
		PracticeTool bool   `json:"practiceTool"`
		Category     string `json:"category"`
		GameMode     string `json:"gameMode"`
		QueueName    string `json:"queueName"`
		MapID        int    `json:"mapId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid lobby request", http.StatusBadRequest)
		return
	}
	if !body.PracticeTool && body.QueueID <= 0 {
		httpError(w, "A valid game mode is required", http.StatusBadRequest)
		return
	}
	if !requireLCUPhase(w, r, lf, "None", "Lobby") {
		return
	}
	var err error
	if body.PracticeTool {
		err = lf.CreatePracticeToolLobby(r.Context())
	} else if strings.EqualFold(strings.TrimSpace(body.Category), "Custom") {
		err = lf.CreateCustomLobby(r.Context(), body.QueueID, body.GameMode, body.QueueName, body.MapID)
	} else {
		err = lf.CreateQueueLobby(r.Context(), body.QueueID)
	}
	if err != nil {
		// Surface the LCU's own message so UI can tell "already in lobby" from "queue unavailable".
		msg := strings.TrimSpace(err.Error())
		if msg == "" {
			msg = "That game mode is not available right now. Riot enables queues server-side, so only modes currently open can be created."
		} else if len(msg) > 300 {
			msg = msg[:300]
		}
		httpError(w, msg, http.StatusBadGateway)
		slog.Info("create lobby failed", "queueId", body.QueueID, "practice", body.PracticeTool, "category", body.Category, "gameMode", body.GameMode, "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuCurrentLobbyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchCurrentLobby(r.Context())
	if err != nil {
		httpError(w, "Lobby is unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuAutoRolesHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		First  string `json:"first"`
		Second string `json:"second"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid body", http.StatusBadRequest)
		return
	}
	allowedRoles := map[string]bool{"TOP": true, "JUNGLE": true, "MIDDLE": true, "BOTTOM": true, "UTILITY": true, "FILL": true}
	body.First = strings.ToUpper(strings.TrimSpace(body.First))
	body.Second = strings.ToUpper(strings.TrimSpace(body.Second))
	if !allowedRoles[body.First] || !allowedRoles[body.Second] {
		httpError(w, "Roles must be TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY, or FILL", http.StatusBadRequest)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "Lobby") {
		return
	}
	if err := lf.AutoSetRoles(r.Context(), body.First, body.Second); err != nil {
		msg := strings.TrimSpace(err.Error())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if msg == "" {
			msg = "Failed to set position preferences"
		}
		httpError(w, msg, http.StatusInternalServerError)
		slog.Info("auto roles failed", "first", body.First, "second", body.Second, "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuCustomStartHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "Lobby") {
		return
	}
	if err := lf.StartCustomGame(r.Context()); err != nil {
		msg := strings.TrimSpace(err.Error())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if msg == "" {
			msg = "Failed to start custom game"
		}
		httpError(w, msg, http.StatusBadGateway)
		slog.Info("custom start failed", "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuLootHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchLCULoot(r.Context())
	if err != nil {
		httpError(w, "Failed to fetch loot", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuWalletHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchLCUWallet(r.Context())
	if err != nil {
		httpError(w, "Failed to fetch League wallet", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuLootRecipesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchLCULootRecipes(r.Context(), r.URL.Query().Get("lootId"))
	if err != nil {
		httpError(w, strings.TrimSpace(err.Error()), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuLootCraftHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var request struct {
		RecipeName string   `json:"recipeName"`
		LootIDs    []string `json:"lootIds"`
		Repeat     int      `json:"repeat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if request.Repeat == 0 {
		request.Repeat = 1
	}
	body, err := lf.CraftLCULootRecipe(r.Context(), request.RecipeName, request.LootIDs, request.Repeat)
	if err != nil {
		httpError(w, strings.TrimSpace(err.Error()), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if len(body) == 0 {
		_ = json.NewEncoder(w).Encode(map[string]bool{"crafted": true})
		return
	}
	_, _ = w.Write(body)
}

func lcuDodgeHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "ChampSelect") {
		return
	}
	if err := lf.DoDodge(r.Context()); err != nil {
		httpError(w, "Failed to dodge", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"dodged": true})
}

func lcuAppearOfflineHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Offline bool `json:"offline"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if err := lf.SetAppearOffline(r.Context(), body.Offline); err != nil {
		httpError(w, "Failed to set offline status", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuAvailabilityHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Availability string `json:"availability"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	body.Availability = strings.ToLower(strings.TrimSpace(body.Availability))
	allowed := map[string]bool{"chat": true, "away": true, "mobile": true, "offline": true}
	if !allowed[body.Availability] {
		httpError(w, "Availability must be chat, away, mobile, or offline", http.StatusBadRequest)
		return
	}
	if err := lf.SetAvailability(r.Context(), body.Availability); err != nil {
		httpError(w, "Failed to update presence", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuStatusMessageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if len([]rune(body.Message)) > 255 {
		httpError(w, "Status message must be 255 characters or fewer", http.StatusBadRequest)
		return
	}
	if err := lf.SetStatusMessage(r.Context(), body.Message); err != nil {
		httpError(w, "Failed to set status message", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuProfileBackgroundHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		SkinID int `json:"skinId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if body.SkinID <= 0 {
		httpError(w, "Choose a valid skin", http.StatusBadRequest)
		return
	}
	if err := lf.SetProfileBackground(r.Context(), body.SkinID); err != nil {
		httpError(w, "Failed to set background", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuProfileIconHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		IconID int `json:"iconId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if body.IconID <= 0 {
		httpError(w, "Choose a valid profile icon", http.StatusBadRequest)
		return
	}
	inventory, err := lf.FetchLCUProfileIconInventory(r.Context())
	if err != nil {
		slog.Warn("lcuProfileIconHandler inventory", "iconID", body.IconID, "error", err)
		httpError(w, "League icon ownership could not be verified. Keep League open and refresh the icon library.", http.StatusServiceUnavailable)
		return
	}
	owned := false
	for _, iconID := range inventory.IconIDs {
		if iconID == body.IconID {
			owned = true
			break
		}
	}
	if !owned {
		if inventory.Complete {
			httpError(w, "This profile icon is not owned by the signed-in Riot account.", http.StatusForbidden)
		} else {
			httpError(w, "League returned a limited icon inventory. Refresh after the client finishes signing in.", http.StatusServiceUnavailable)
		}
		return
	}
	if err := lf.SetProfileIcon(r.Context(), body.IconID); err != nil {
		slog.Warn("lcuProfileIconHandler", "iconID", body.IconID, "error", err)
		httpError(w, profileIconActionError(err), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func profileIconActionError(err error) string {
	message := strings.ToLower(err.Error())
	if detail := lcuErrorDetail(err.Error()); detail != "" {
		return "League rejected this icon: " + detail
	}
	switch {
	case strings.Contains(message, "401"), strings.Contains(message, "403"), strings.Contains(message, "unauthor"):
		return "League rejected the profile icon because the client session is not ready. Keep League open and signed in, then retry."
	case strings.Contains(message, "400"), strings.Contains(message, "not owned"), strings.Contains(message, "unowned"), strings.Contains(message, "inventory"):
		return "League could not apply this icon. Refresh the library and retry while the League client is signed in."
	case strings.Contains(message, "404"), strings.Contains(message, "not found"):
		return "League could not find this profile icon. Refresh the library and try again."
	default:
		return "League rejected the profile icon. Keep League open and signed in, then retry."
	}
}

func lcuErrorDetail(raw string) string {
	start := strings.Index(raw, "{")
	if start < 0 {
		return ""
	}
	var payload struct {
		Message   string `json:"message"`
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal([]byte(raw[start:]), &payload); err != nil {
		return ""
	}
	detail := strings.TrimSpace(payload.Message)
	if detail == "" {
		detail = strings.TrimSpace(payload.ErrorCode)
	}
	if detail == "" {
		return ""
	}
	return strings.TrimSpace(strings.Trim(detail, "\\\""))
}

func lcuHonorBallotHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.GetHonorBallot(r.Context())
	if err != nil {
		httpError(w, "Failed to get honor ballot", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuHonorPlayerHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		SummonerID uint64 `json:"summonerId"`
		PUUID      string `json:"puuid"`
		GameID     uint64 `json:"gameId"`
		HonorType  string `json:"honorType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	body.PUUID = strings.TrimSpace(body.PUUID)
	body.HonorType = strings.ToUpper(strings.TrimSpace(body.HonorType))
	if body.SummonerID == 0 || body.GameID == 0 || body.PUUID == "" || body.HonorType == "" {
		httpError(w, "Honor player details are incomplete", http.StatusBadRequest)
		return
	}
	if err := lf.HonorPlayer(r.Context(), body.SummonerID, body.PUUID, body.HonorType, body.GameID); err != nil {
		httpError(w, "Failed to honor player", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuPlayAgainHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if !requireLCUPhase(w, r, lf, "EndOfGame") {
		return
	}
	if err := lf.PlayAgain(r.Context()); err != nil {
		httpError(w, "Failed to play again", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuClaimEventRewardsHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	count, err := lf.ClaimEventRewards(r.Context())
	if err != nil {
		httpError(w, "Failed to claim event rewards", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"claimed": count})
}

func lcuGameflowPhaseHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	phase, err := lf.GetGameflowPhase(r.Context())
	if err != nil {
		httpError(w, "Failed to get gameflow phase", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"phase": phase})
}

func lcuChampSelectHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.GetChampSelectSession(r.Context())
	if err != nil {
		httpError(w, "No active champ select session", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuChampSelectReadHandler(w http.ResponseWriter, r *http.Request, message string, fetch func(*riotclient.Lockfile, context.Context) ([]byte, error)) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := fetch(lf, r.Context())
	if err != nil {
		httpError(w, message, http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func lcuChampSelectPickableHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectReadHandler(w, r, "Pickable champions are unavailable", func(lf *riotclient.Lockfile, ctx context.Context) ([]byte, error) {
		return lf.FetchChampSelectPickable(ctx)
	})
}

func lcuChampSelectBannableHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectReadHandler(w, r, "Bannable champions are unavailable", func(lf *riotclient.Lockfile, ctx context.Context) ([]byte, error) {
		return lf.FetchChampSelectBannable(ctx)
	})
}

func lcuChampSelectSkinsHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectReadHandler(w, r, "Champion-select skins are unavailable", func(lf *riotclient.Lockfile, ctx context.Context) ([]byte, error) {
		return lf.FetchChampSelectSkins(ctx)
	})
}

func lcuChampSelectPickOrderSwapsHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectReadHandler(w, r, "Pick-order swaps are unavailable", func(lf *riotclient.Lockfile, ctx context.Context) ([]byte, error) {
		return lf.FetchChampSelectPickOrderSwaps(ctx)
	})
}

func lcuChampSelectPositionSwapsHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectReadHandler(w, r, "Role swaps are unavailable", func(lf *riotclient.Lockfile, ctx context.Context) ([]byte, error) {
		return lf.FetchChampSelectPositionSwaps(ctx)
	})
}

func champSelectLockfile(w http.ResponseWriter, r *http.Request) *riotclient.Lockfile {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return nil
	}
	if !requireLCUPhase(w, r, lf, "ChampSelect") {
		return nil
	}
	return lf
}

// validateChampSelectActionPayload catches stale phone/desktop requests before
// they reach the LCU mutation. League's action IDs are the authority; this
// guard only rejects an ID that disappeared/completed or a champion that is
// already occupied by another pick/ban. If an older client returns an unknown
// session shape, the LCU remains the final authority.
func validateChampSelectActionPayload(payload []byte, actionID, championID int) error {
	var session struct {
		Actions [][]struct {
			ID         *int   `json:"id"`
			ChampionID int    `json:"championId"`
			Completed  bool   `json:"completed"`
			Type       string `json:"type"`
		} `json:"actions"`
	}
	if err := json.Unmarshal(payload, &session); err != nil {
		return nil
	}
	if len(session.Actions) == 0 {
		return nil
	}
	found := false
	for _, turn := range session.Actions {
		for _, action := range turn {
			if action.ID == nil {
				continue
			}
			if *action.ID == actionID {
				found = true
				if championID == riotclient.ArenaBraveryChampionID && action.Type != "pick" {
					return fmt.Errorf("Arena Bravery is only valid for a pick action")
				}
				if action.Completed {
					return fmt.Errorf("champion-select action %d is already complete", actionID)
				}
				continue
			}
			if championID > 0 && action.ChampionID == championID && !action.Completed && (action.Type == "pick" || action.Type == "ban") {
				return fmt.Errorf("champion %d is already occupied by the draft", championID)
			}
		}
	}
	if !found {
		return fmt.Errorf("champion-select action %d is no longer available", actionID)
	}
	return nil
}

func lcuChampSelectActionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := champSelectLockfile(w, r)
	if lf == nil {
		return
	}
	var body struct {
		ActionID   *int `json:"actionId"`
		ChampionID *int `json:"championId"`
		Completed  bool `json:"completed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid champion-select action", http.StatusBadRequest)
		return
	}
	if body.ActionID == nil || body.ChampionID == nil {
		httpError(w, "Champion-select actionId and championId are required", http.StatusBadRequest)
		return
	}
	if current, currentErr := lf.GetChampSelectSession(r.Context()); currentErr == nil {
		if validationErr := validateChampSelectActionPayload(current, *body.ActionID, *body.ChampionID); validationErr != nil {
			httpError(w, validationErr.Error(), http.StatusConflict)
			return
		}
	}
	if err := lf.UpdateChampSelectAction(r.Context(), *body.ActionID, *body.ChampionID, body.Completed); err != nil {
		slog.Warn("League rejected champion-select action", "actionID", *body.ActionID, "championID", *body.ChampionID, "completed", body.Completed, "error", err)
		if body.Completed {
			httpError(w, "League did not apply the lock. The turn may have ended or the champion is unavailable.", http.StatusBadGateway)
		} else {
			httpError(w, "League did not apply the hover. The turn may not be open or the champion is unavailable.", http.StatusBadGateway)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true, "completed": body.Completed})
}

func lcuChampSelectSelectionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := champSelectLockfile(w, r)
	if lf == nil {
		return
	}
	var body struct {
		Spell1ID       int `json:"spell1Id"`
		Spell2ID       int `json:"spell2Id"`
		SelectedSkinID int `json:"selectedSkinId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid champion-select selection", http.StatusBadRequest)
		return
	}
	if err := lf.UpdateChampSelectSelection(r.Context(), body.Spell1ID, body.Spell2ID, body.SelectedSkinID); err != nil {
		httpError(w, "League rejected the champion-select loadout", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuChampSelectRerollHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := champSelectLockfile(w, r)
	if lf == nil {
		return
	}
	if err := lf.RerollChampSelect(r.Context()); err != nil {
		httpError(w, "League rejected the reroll", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuChampSelectBenchSwapHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := champSelectLockfile(w, r)
	if lf == nil {
		return
	}
	var body struct {
		ChampionID int `json:"championId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid bench champion", http.StatusBadRequest)
		return
	}
	if err := lf.SwapBenchChampion(r.Context(), body.ChampionID); err != nil {
		httpError(w, "League rejected the bench swap", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuChampSelectSwapHandler(w http.ResponseWriter, r *http.Request, kind string) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := champSelectLockfile(w, r)
	if lf == nil {
		return
	}
	var body struct {
		ID     *int   `json:"id"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid champion-select swap", http.StatusBadRequest)
		return
	}
	if body.ID == nil {
		httpError(w, "Champion-select swap id is required", http.StatusBadRequest)
		return
	}
	if err := lf.UpdateChampSelectSwap(r.Context(), kind, strings.ToLower(strings.TrimSpace(body.Action)), *body.ID); err != nil {
		slog.Warn("League rejected champion-select swap", "kind", kind, "id", *body.ID, "action", body.Action, "error", err)
		httpError(w, "League rejected the swap. It may be unavailable in this queue or the request may have expired.", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuChampSelectPickOrderSwapHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectSwapHandler(w, r, "pick-order")
}

func lcuChampSelectPositionSwapHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectSwapHandler(w, r, "position")
}

func lcuChampSelectRunesHandler(w http.ResponseWriter, r *http.Request) {
	lcuChampSelectReadHandler(w, r, "Rune pages are unavailable", func(lf *riotclient.Lockfile, ctx context.Context) ([]byte, error) {
		return lf.FetchRunePages(ctx)
	})
}

func lcuChampSelectRuneCatalogHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	perks, err := lf.FetchRunePerks(r.Context())
	if err != nil {
		slog.Warn("load rune perk catalogue", "error", err)
		httpError(w, "Rune catalogue is unavailable", http.StatusBadGateway)
		return
	}
	styles, err := lf.FetchRuneStyles(r.Context())
	if err != nil {
		slog.Warn("load rune style catalogue", "error", err)
		httpError(w, "Rune style catalogue is unavailable", http.StatusBadGateway)
		return
	}
	if !json.Valid(perks) || !json.Valid(styles) {
		httpError(w, "League returned an invalid rune catalogue", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]json.RawMessage{
		"perks":  perks,
		"styles": styles,
	})
}

func lcuChampSelectRuneSelectHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		PageID int `json:"pageId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid rune page", http.StatusBadRequest)
		return
	}
	if err := lf.SetCurrentRunePage(r.Context(), body.PageID); err != nil {
		httpError(w, "League rejected the rune page", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func lcuChampSelectRunePageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	var payload map[string]any
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpError(w, "Invalid rune page", http.StatusBadRequest)
		return
	}
	pageID, _ := payload["id"].(float64)
	pageIDInt := int(pageID)
	switch r.Method {
	case http.MethodPost:
		clean, err := validatedRunePagePayload(payload)
		if err != nil {
			httpError(w, err.Error(), http.StatusBadRequest)
			return
		}
		body, err := lf.CreateRunePage(r.Context(), clean)
		if err != nil {
			slog.Warn("create rune page", "error", err)
			httpError(w, "Could not create rune page", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	case http.MethodPut:
		if pageIDInt <= 0 {
			httpError(w, "Rune page ID must be positive", http.StatusBadRequest)
			return
		}
		clean, err := validatedRunePagePayload(payload)
		if err != nil {
			httpError(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := lf.UpdateRunePage(r.Context(), pageIDInt, clean); err != nil {
			slog.Warn("update rune page", "page_id", pageIDInt, "error", err)
			httpError(w, "Could not save rune page", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	case http.MethodDelete:
		if pageIDInt <= 0 {
			httpError(w, "Rune page ID must be positive", http.StatusBadRequest)
			return
		}
		if err := lf.DeleteRunePage(r.Context(), pageIDInt); err != nil {
			slog.Warn("delete rune page", "page_id", pageIDInt, "error", err)
			httpError(w, "Could not delete rune page", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

func validatedRunePagePayload(payload map[string]any) (map[string]any, error) {
	name, _ := payload["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 25 {
		return nil, fmt.Errorf("Rune page name must be between 1 and 25 characters")
	}
	primaryStyleID, primaryOK := payload["primaryStyleId"].(float64)
	subStyleID, subOK := payload["subStyleId"].(float64)
	if !primaryOK || !subOK || primaryStyleID <= 0 || subStyleID <= 0 || primaryStyleID == subStyleID {
		return nil, fmt.Errorf("Choose valid primary and secondary rune styles")
	}
	rawPerks, ok := payload["selectedPerkIds"].([]any)
	if !ok || len(rawPerks) != 9 {
		return nil, fmt.Errorf("A rune page must contain exactly 9 perks")
	}
	perkIDs := make([]int, 0, len(rawPerks))
	for _, raw := range rawPerks {
		value, ok := raw.(float64)
		if !ok || value <= 0 || value != float64(int(value)) {
			return nil, fmt.Errorf("Rune page contains an invalid perk")
		}
		perkIDs = append(perkIDs, int(value))
	}
	clean := map[string]any{
		"name":            name,
		"primaryStyleId":  int(primaryStyleID),
		"subStyleId":      int(subStyleID),
		"selectedPerkIds": perkIDs,
	}
	if temporary, ok := payload["isTemporary"].(bool); ok {
		clean["isTemporary"] = temporary
	}
	return clean, nil
}

func lcuFriendsHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := lf.FetchLCUFriends(r.Context())
	if err != nil {
		httpError(w, "Could not load League friends", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func qolPreferencesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(qolManager.Preferences())
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var preferences qol.Preferences
	if err := json.NewDecoder(r.Body).Decode(&preferences); err != nil {
		httpError(w, "Invalid QoL preferences", http.StatusBadRequest)
		return
	}
	if err := qolManager.Update(preferences); err != nil {
		slog.Error("qolPreferencesHandler", "error", err)
		httpError(w, "Failed to save QoL preferences", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(preferences)
}

func qolStateHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "League client is not connected", http.StatusServiceUnavailable)
		return
	}
	state, err := lf.FetchQoLState(r.Context())
	if err != nil {
		httpError(w, "League client is not ready", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(state)
}

func lcuHealthHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"connected": false, "latencyMs": 0, "uptime": 0, "memoryMB": 0, "cpuPercent": 0,
		})
		return
	}
	// Measure LCU latency
	start := time.Now()
	_, err := lf.DoRequest(r.Context(), "GET", "/lol-gameflow/v1/gameflow-phase")
	latency := time.Since(start).Milliseconds()
	if err != nil {
		latency = 0
	}
	// Get LeagueClient process info (uptime + memory)
	pinfo := riotclient.GetLeagueProcessInfo()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"connected":  true,
		"latencyMs":  latency,
		"uptime":     pinfo.UptimeSec,
		"memoryMB":   pinfo.MemoryMB,
		"cpuPercent": pinfo.CPUPercent,
	})
}

func lcuServerStatusHandler(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	if region == "" {
		region = "NA"
	}
	statuses, err := riotapi.GetRegionStatus(region)
	if err != nil {
		httpError(w, "Failed to fetch server status", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(statuses)
}

func qolQueuePresetsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		prefs := qolManager.Preferences()
		if prefs.RolePresets == nil {
			prefs.RolePresets = make(map[string]qol.RolePreset)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"presets": prefs.RolePresets,
			"queues":  qol.QueueKeyLabels(),
		})
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Queue  string         `json:"queue"`
		Preset qol.RolePreset `json:"preset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if body.Queue == "" || body.Preset.First == "" || body.Preset.Second == "" {
		httpError(w, "Queue and both roles are required", http.StatusBadRequest)
		return
	}
	prefs := qolManager.Preferences()
	if prefs.RolePresets == nil {
		prefs.RolePresets = make(map[string]qol.RolePreset)
	}
	prefs.RolePresets[body.Queue] = body.Preset
	if err := qolManager.Update(prefs); err != nil {
		httpError(w, "Failed to save role preset", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(prefs.RolePresets)
}

func lcuAssetProxyHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		http.Error(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	path := r.URL.Path
	body, err := lf.DoRequest(r.Context(), "GET", path)
	if err != nil {
		http.Error(w, "Asset not found", http.StatusNotFound)
		return
	}

	pLower := strings.ToLower(path)
	if strings.HasSuffix(pLower, ".jpg") || strings.HasSuffix(pLower, ".jpeg") {
		w.Header().Set("Content-Type", "image/jpeg")
	} else if strings.HasSuffix(pLower, ".png") {
		w.Header().Set("Content-Type", "image/png")
	} else if strings.HasSuffix(pLower, ".json") {
		w.Header().Set("Content-Type", "application/json")
	} else if strings.HasSuffix(pLower, ".svg") {
		w.Header().Set("Content-Type", "image/svg+xml")
	}

	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(body)
}

// lcuProfileIconMetadataHandler exposes the LCU's current icon catalogue
// through the same-origin API. Keeping this behind /api avoids frontend dev
// servers and packaged builds taking different metadata paths.
func lcuProfileIconMetadataHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		http.Error(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.DoRequest(r.Context(), "GET", "/lol-game-data/assets/v1/summoner-icons.json")
	if err != nil {
		slog.Warn("lcuProfileIconMetadataHandler", "error", err)
		http.Error(w, "Profile icon metadata unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

// lcuOwnedProfileIconsHandler returns only profile icons that League reports
// for the signed-in account. Catalogue metadata remains a separate discovery
// source and must never be treated as ownership proof.
func lcuOwnedProfileIconsHandler(w http.ResponseWriter, r *http.Request) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		http.Error(w, "LCU not connected", http.StatusServiceUnavailable)
		return
	}
	inventory, err := lf.FetchLCUProfileIconInventory(r.Context())
	if err != nil {
		slog.Warn("lcuOwnedProfileIconsHandler", "error", err)
		http.Error(w, "Profile icon ownership unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(inventory)
}
