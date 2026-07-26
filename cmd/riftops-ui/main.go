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
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
	"github.com/HassanSalah120/RiftOps/internal/engine"
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
	version       = "2.4.1"
	port          = 24080
	clientURL     = fmt.Sprintf("http://127.0.0.1:%d", port)

	httpServer *http.Server

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
		origin := r.Header.Get("Origin")
		if origin != "" && !strings.HasPrefix(origin, "http://127.0.0.1") && !strings.HasPrefix(origin, "http://localhost") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
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
}

func shutdownHTTPServer() {
	if httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
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
	if err := os.MkdirAll(path, 0755); err != nil {
		logFatalStartup("RiftOps could not create data directory", err.Error())
		return
	}

	instance, err := singleinstance.Acquire(filepath.Join(path, "lock"))
	if err != nil {
		logFatalStartup("RiftOps could not start", err.Error())
		return
	}
	defer instance.Close()

	logger, logFile, err := diagnostics.OpenLogger(filepath.Join(filepath.Dir(path), "debug.log"))
	if err == nil {
		slog.SetDefault(logger)
		defer logFile.Close()
	}

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
	mux.HandleFunc("/api/snapshot", originCheck(getSnapshot))
	mux.HandleFunc("/api/events", originCheck(sseHandler))
	mux.HandleFunc("/api/profiles", originCheck(getProfiles))
	mux.HandleFunc("/api/select-profile", originCheck(selectProfile))
	mux.HandleFunc("/api/save-profile", originCheck(saveProfile))
	mux.HandleFunc("/api/delete-profile", originCheck(deleteProfile))
	mux.HandleFunc("/api/profiles/export", originCheck(exportProfiles))
	mux.HandleFunc("/api/profiles/import", originCheck(importProfiles))
	mux.HandleFunc("/api/preferences", originCheck(getPreferences))
	mux.HandleFunc("/api/save-preferences", originCheck(savePreferences))
	mux.HandleFunc("/api/set-enabled", originCheck(setEnabled))
	mux.HandleFunc("/api/set-status", originCheck(setStatus))
	mux.HandleFunc("/api/start", originCheck(startEngine))
	mux.HandleFunc("/api/stop", originCheck(stopEngine))
	mux.HandleFunc("/api/capture-session", originCheck(captureSession))
	mux.HandleFunc("/api/forget-session", originCheck(forgetSession))
	mux.HandleFunc("/api/session-status", originCheck(getSessionStatus))
	mux.HandleFunc("/api/switch-profile", originCheck(switchProfile))
	mux.HandleFunc("/api/set-autostart", originCheck(setAutostart))
	mux.HandleFunc("/api/autostart", originCheck(getAutostart))
	mux.HandleFunc("/api/check-update", originCheck(checkUpdate))
	mux.HandleFunc("/api/quit", originCheck(quitApp))

	// Riot Dev API routes
	mux.HandleFunc("/api/riot/account", originCheck(riotAccountHandler))
	mux.HandleFunc("/api/riot/summoner", originCheck(riotSummonerHandler))
	mux.HandleFunc("/api/riot/mastery", originCheck(riotMasteryHandler))
	mux.HandleFunc("/api/riot/league", originCheck(riotLeagueHandler))
	mux.HandleFunc("/api/riot/current-game", originCheck(riotCurrentGameHandler))
	mux.HandleFunc("/api/riot/status", originCheck(riotStatusHandler))
	mux.HandleFunc("/api/riot/configured", originCheck(riotConfiguredHandler))

	// Data Dragon routes
	mux.HandleFunc("/api/ddragon/version", originCheck(ddragonVersionHandler))
	mux.HandleFunc("/api/ddragon/champions", originCheck(ddragonChampionsHandler))
	mux.HandleFunc("/api/ddragon/profile-icons", originCheck(ddragonProfileIconsHandler))

	// LCU (local client) data routes — no RG_API_KEY needed
	mux.HandleFunc("/api/lcu/status", originCheck(lcuStatusHandler))
	mux.HandleFunc("/api/lcu/profile", originCheck(lcuProfileHandler))
	mux.HandleFunc("/api/lcu/launch-league", originCheck(lcuLaunchLeagueHandler))
	mux.HandleFunc("/api/lcu/match-history", originCheck(lcuMatchHistoryHandler))
	mux.HandleFunc("/api/lcu/game-detail", originCheck(lcuGameDetailHandler))
	mux.HandleFunc("/api/lcu/skins", originCheck(lcuSkinsHandler))
	mux.HandleFunc("/api/lcu/background-champions", originCheck(lcuBackgroundChampionsHandler))
	mux.HandleFunc("/api/lcu/background-skins", originCheck(lcuBackgroundSkinsHandler))
	mux.HandleFunc("/api/lcu/auto-accept", originCheck(lcuAutoAcceptHandler))
	mux.HandleFunc("/api/lcu/auto-requeue", originCheck(lcuAutoRequeueHandler))
	mux.HandleFunc("/api/lcu/stop-queue", originCheck(lcuStopQueueHandler))
	mux.HandleFunc("/api/lcu/auto-roles", originCheck(lcuAutoRolesHandler))
	mux.HandleFunc("/api/lcu/loot", originCheck(lcuLootHandler))
	// QoL actions
	mux.HandleFunc("/api/lcu/dodge", originCheck(lcuDodgeHandler))
	mux.HandleFunc("/api/lcu/appear-offline", originCheck(lcuAppearOfflineHandler))
	mux.HandleFunc("/api/lcu/availability", originCheck(lcuAvailabilityHandler))
	mux.HandleFunc("/api/lcu/status-message", originCheck(lcuStatusMessageHandler))
	mux.HandleFunc("/api/lcu/profile-background", originCheck(lcuProfileBackgroundHandler))
	mux.HandleFunc("/api/lcu/profile-icon", originCheck(lcuProfileIconHandler))
	mux.HandleFunc("/api/lcu/honor-ballot", originCheck(lcuHonorBallotHandler))
	mux.HandleFunc("/api/lcu/honor-player", originCheck(lcuHonorPlayerHandler))
	mux.HandleFunc("/api/lcu/play-again", originCheck(lcuPlayAgainHandler))
	mux.HandleFunc("/api/lcu/claim-event-rewards", originCheck(lcuClaimEventRewardsHandler))
	mux.HandleFunc("/api/lcu/gameflow-phase", originCheck(lcuGameflowPhaseHandler))
	mux.HandleFunc("/api/lcu/champ-select", originCheck(lcuChampSelectHandler))
	mux.HandleFunc("/api/qol/preferences", originCheck(qolPreferencesHandler))
	mux.HandleFunc("/api/qol/state", originCheck(qolStateHandler))
	mux.HandleFunc("/lol-game-data/", lcuAssetProxyHandler)

	distFS, err := fs.Sub(frontendFS, "frontend/dist")
	if err != nil {
		slog.Error("Failed to load embedded frontend files", "error", err)
	} else {
		mux.Handle("/", http.FileServer(http.FS(distFS)))
	}

	httpServer = &http.Server{
		Handler: mux,
		BaseContext: func(_ net.Listener) context.Context {
			return context.Background()
		},
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		logFatalStartup("Port conflict", fmt.Sprintf("Port %d is already in use.", port))
		return
	}
	go func() {
		slog.Info("Starting Web UI Server", "url", clientURL)
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("Failed to start web server", "error", err)
		}
	}()

	// The macOS host owns the native WebKit event loop so RiftOps appears as a
	// normal Dock application. Windows keeps its WebView2 window and tray flow.
	if runtime.GOOS == "darwin" {
		safeOpenDashboard(clientURL)
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
				backendEngine.Stop()
				destroyWebView()
				shutdownHTTPServer()
				systray.Quit()
			}
		}
	}()
}

func onTrayExit() {
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
	w.Header().Set("Access-Control-Allow-Origin", "*")

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
			RiotClientArgs: append([]string(nil), profile.RiotClientArgs...),
			GameArgs:       append([]string(nil), profile.GameArgs...),
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
		"game":          prefs.DefaultGame,
		"startupStatus": prefs.StartupStatus,
		"connectToMUC":  prefs.ConnectToMUC,
		"checkUpdates":  prefs.CheckUpdates,
	})
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
	if !body.StopExisting {
		adapter := platform.New()
		processes, err := adapter.KnownProcesses(r.Context())
		if err == nil && len(processes) > 0 {
			w.WriteHeader(http.StatusConflict)
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
			GameArgs:       append([]string(nil), profile.GameArgs...),
		})
	}()
	w.WriteHeader(http.StatusOK)
}

func stopEngine(w http.ResponseWriter, r *http.Request) {
	backendEngine.Stop()
	w.WriteHeader(http.StatusOK)
}

// UNDER DEVELOPMENT: Session Vault (Account Switcher) feature endpoints under development
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

func checkUpdate(w http.ResponseWriter, r *http.Request) {
	prefs := backendEngine.Settings()
	if !prefs.CheckUpdates {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"available": false})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	release, err := (update.Checker{}).Latest(ctx)
	if err != nil || release.Version == prefs.PromptedUpdate {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"available": false})
		return
	}
	newer, err := update.IsNewer(version, release.Version)
	if err != nil || !newer {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"available": false})
		return
	}
	_ = backendEngine.MarkUpdatePrompted(release.Version)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"available": true,
		"release": map[string]interface{}{
			"version": release.Version,
			"url":     release.URL,
		},
	})
}

func quitApp(w http.ResponseWriter, r *http.Request) {
	backendEngine.Stop()
	shutdownHTTPServer()
	systray.Quit()
	w.WriteHeader(http.StatusOK)
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
	} else if os.Getenv("RG_API_KEY") != "" {
		source = "env"
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
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "LCU not connected — launch League of Legends first", http.StatusServiceUnavailable)
		return
	}
	body, err := lf.FetchLCUMatchHistory(r.Context(), 0, 50)
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
	body, err := lf.FetchLCUChampionSkins(r.Context(), championID)
	if err != nil {
		httpError(w, "Failed to fetch champion skins", http.StatusInternalServerError)
		slog.Error("lcuBackgroundSkinsHandler", "championID", championID, "error", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
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
		httpError(w, "Failed to set position preferences", http.StatusInternalServerError)
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
	if err := lf.SetProfileIcon(r.Context(), body.IconID); err != nil {
		httpError(w, "Failed to set profile icon", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
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
