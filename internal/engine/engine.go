package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/certificate"
	"github.com/HassanSalah120/RiftOps/internal/chatproxy"
	"github.com/HassanSalah120/RiftOps/internal/configproxy"
	"github.com/HassanSalah120/RiftOps/internal/fakeplayer"
	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/platform"
	"github.com/HassanSalah120/RiftOps/internal/presence"
	"github.com/HassanSalah120/RiftOps/internal/sessionvault"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

// Riot's client-config service is rewritten to a publicly trusted hostname
// whose DNS records resolve only to loopback. This is the same trust model as
// the original Deceive proxy, without relying on the predecessor's domain or
// certificate service.
const LocalhostDomain = "riftops.backloop.dev"

type Phase string

const (
	PhaseIdle           Phase = "idle"
	PhasePreflight      Phase = "preflight"
	PhasePreparingProxy Phase = "preparing-proxy"
	PhaseLaunching      Phase = "launching"
	PhaseWaiting        Phase = "waiting-for-chat"
	PhaseActive         Phase = "active"
	PhaseStopping       Phase = "stopping"
	PhaseError          Phase = "error"
)

type Snapshot struct {
	Phase     Phase
	Status    model.Status
	Enabled   bool
	Game      model.Game
	Detail    string
	ConfigURL string
	ChatPort  int
	StartedAt time.Time
}

type RunOptions struct {
	Game           model.Game
	Status         model.Status
	Patchline      string
	StopExisting   bool
	RiotClientArgs []string
	GameArgs       []string
}

type ProfileSwitchResult struct {
	Profile                settings.LaunchProfile
	RefreshedCurrent       bool
	TargetSessionAvailable bool
	TargetSessionExpired   bool
}

var ErrRiotAlreadyRunning = errors.New("Riot Client is already running")

type Engine struct {
	mu        sync.RWMutex
	store     settings.Store
	config    settings.Settings
	policy    *runtimePolicy
	proxy     *chatproxy.Proxy
	adapter   platform.Adapter
	vault     *sessionvault.Vault
	cancel    context.CancelFunc
	running   bool
	snapshot  Snapshot
	events    chan Snapshot
	commandMu sync.Mutex
	saveMu    sync.Mutex
}

func New(store settings.Store) (*Engine, error) {
	config, err := store.Load()
	if err != nil {
		return nil, err
	}
	vault, vaultErr := sessionvault.Default(filepath.Join(filepath.Dir(store.Path), "session-vault"))
	if vaultErr != nil {
		slog.Debug("saved-login vault unavailable", "error", vaultErr)
	}
	e := &Engine{store: store, config: config, events: make(chan Snapshot, 32), vault: vault}
	e.snapshot = Snapshot{Phase: PhaseIdle, Status: config.Status, Enabled: config.Enabled, Game: config.DefaultGame}
	return e, nil
}

func (e *Engine) Events() <-chan Snapshot { return e.events }

func (e *Engine) Snapshot() Snapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.snapshot
}

func (e *Engine) Settings() settings.Settings {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.config.Clone()
}

// ResolveRiotClientExecutable validates a configured location or falls back to
// native installation discovery.
func (e *Engine) ResolveRiotClientExecutable() (string, error) {
	e.mu.RLock()
	configured := e.config.RiotClientPath
	e.mu.RUnlock()
	return resolveRiotClientExecutable(platform.New(), configured)
}

func resolveRiotClientExecutable(adapter platform.Adapter, configured string) (string, error) {
	if strings.TrimSpace(configured) != "" {
		executable, err := platform.ResolveRiotClientExecutable(configured)
		if err != nil {
			return "", fmt.Errorf("saved Riot Client location is invalid: %w", err)
		}
		return executable, nil
	}
	return adapter.DiscoverRiotClient()
}

func (e *Engine) LaunchProfiles() []settings.LaunchProfile {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.config.Clone().Profiles
}

func (e *Engine) ActiveLaunchProfile() settings.LaunchProfile {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.config.Clone().ActiveProfile()
}

func (e *Engine) SelectLaunchProfile(id string) error {
	e.mu.Lock()
	updated := e.config.Clone()
	if err := updated.SelectProfile(id); err != nil {
		e.mu.Unlock()
		return err
	}
	e.config = updated
	e.snapshot.Status, e.snapshot.Enabled, e.snapshot.Game = updated.Status, updated.Enabled, updated.DefaultGame
	snapshot := e.snapshot
	e.mu.Unlock()
	if err := e.saveSettings(); err != nil {
		return err
	}
	e.emit(snapshot)
	return nil
}

func (e *Engine) SaveLaunchProfile(profile settings.LaunchProfile) error {
	e.mu.Lock()
	updated := e.config.Clone()
	if err := updated.UpsertProfile(profile); err != nil {
		e.mu.Unlock()
		return err
	}
	e.config = updated
	e.mu.Unlock()
	return e.saveSettings()
}

func (e *Engine) DeleteLaunchProfile(id string) error {
	e.mu.Lock()
	updated := e.config.Clone()
	if err := updated.DeleteProfile(id); err != nil {
		e.mu.Unlock()
		return err
	}
	e.config = updated
	e.snapshot.Status, e.snapshot.Enabled, e.snapshot.Game = updated.Status, updated.Enabled, updated.DefaultGame
	snapshot := e.snapshot
	e.mu.Unlock()
	if err := e.saveSettings(); err != nil {
		return err
	}
	if e.vault != nil {
		if err := e.vault.Delete(id); err != nil {
			slog.Warn("delete saved Riot login failed", "error", err)
		}
	}
	e.emit(snapshot)
	return nil
}

// ExportProfiles returns a copy of all launch profiles (for export).
func (e *Engine) ExportProfiles() []settings.LaunchProfile {
	return e.LaunchProfiles()
}

// ImportProfiles merges the given profiles into the existing list.
// Profiles with matching IDs are updated; new profiles are appended.
func (e *Engine) ImportProfiles(imported []settings.LaunchProfile) error {
	e.mu.Lock()
	updated := e.config.Clone()
	byID := make(map[string]int, len(updated.Profiles))
	for i, p := range updated.Profiles {
		byID[p.ID] = i
	}
	for _, p := range imported {
		if idx, ok := byID[p.ID]; ok {
			updated.Profiles[idx] = p
		} else {
			updated.Profiles = append(updated.Profiles, p)
		}
	}
	if err := updated.Validate(); err != nil {
		e.mu.Unlock()
		return fmt.Errorf("imported profiles are invalid: %w", err)
	}
	e.config = updated
	e.mu.Unlock()
	return e.saveSettings()
}

func (e *Engine) SavedLoginStatus() (sessionvault.Status, error) {
	e.mu.RLock()
	vault := e.vault
	profileID := e.config.ActiveProfileID
	e.mu.RUnlock()
	if vault == nil {
		return sessionvault.Status{}, errors.New("saved Riot logins are unavailable on this platform")
	}
	return vault.Status(profileID)
}

func (e *Engine) CaptureSavedLogin(ctx context.Context, lifetime time.Duration) error {
	e.mu.RLock()
	vault := e.vault
	profileID := e.config.ActiveProfileID
	e.mu.RUnlock()
	if vault == nil {
		return errors.New("saved Riot logins are unavailable on this platform")
	}
	processes, err := platform.New().KnownProcesses(ctx)
	if err != nil {
		return fmt.Errorf("inspect Riot Client before saving its session: %w", err)
	}
	if len(processes) == 0 {
		return errors.New("Riot Client must be running and signed in before its session can be saved")
	}
	if err := vault.Capture(profileID, lifetime); err != nil {
		return err
	}
	return nil
}

func (e *Engine) RiotSessionActive(ctx context.Context) (bool, error) {
	processes, err := platform.New().KnownProcesses(ctx)
	return len(processes) > 0, err
}

func (e *Engine) ForgetSavedLogin() error {
	e.mu.RLock()
	vault := e.vault
	profileID := e.config.ActiveProfileID
	e.mu.RUnlock()
	if vault == nil {
		return errors.New("saved Riot logins are unavailable on this platform")
	}
	return vault.Delete(profileID)
}

// SwitchLaunchProfile performs account switching as one ordered transaction.
// The current profile is refreshed before any Riot process is stopped, Riot is
// then fully closed, the refresh is finalized, and only then is the target
// profile selected. Run restores the target session immediately afterwards.
func (e *Engine) SwitchLaunchProfile(ctx context.Context, id string, lifetime time.Duration) (ProfileSwitchResult, error) {
	e.mu.RLock()
	updated := e.config.Clone()
	current := updated.ActiveProfile()
	vault := e.vault
	e.mu.RUnlock()
	if err := updated.SelectProfile(id); err != nil {
		return ProfileSwitchResult{}, err
	}
	target := updated.ActiveProfile()

	result := ProfileSwitchResult{Profile: target}
	if vault != nil {
		refreshed, err := vault.RefreshIfEnrolled(current.ID, lifetime)
		if err != nil {
			return ProfileSwitchResult{}, fmt.Errorf("refresh current profile %q: %w", current.Name, err)
		}
		result.RefreshedCurrent = refreshed
	}

	e.Stop()
	adapter := platform.New()
	if err := adapter.StopKnownProcesses(ctx); err != nil {
		processes, inspectErr := adapter.KnownProcesses(ctx)
		if inspectErr != nil || len(processes) > 0 {
			return ProfileSwitchResult{}, fmt.Errorf("close Riot Client before switching profiles: %w", err)
		}
	}
	if err := waitForNoRiotProcesses(ctx, adapter); err != nil {
		return ProfileSwitchResult{}, err
	}
	if err := e.waitUntilStopped(ctx); err != nil {
		return ProfileSwitchResult{}, err
	}

	if vault != nil && result.RefreshedCurrent {
		if _, err := vault.RefreshIfEnrolled(current.ID, lifetime); err != nil {
			// The pre-shutdown refresh is already safe. Keep switching instead of
			// stranding the user after Riot has been closed.
			slog.Warn("post-shutdown saved login refresh failed; using pre-shutdown copy", "profile", current.Name, "error", err)
		}
	}

	if vault != nil {
		_, err := vault.Status(target.ID)
		switch {
		case err == nil:
			result.TargetSessionAvailable = true
		case errors.Is(err, sessionvault.ErrExpired):
			result.TargetSessionExpired = true
		case errors.Is(err, sessionvault.ErrNotFound):
		default:
			return ProfileSwitchResult{}, fmt.Errorf("inspect target profile session: %w", err)
		}
	}
	if err := e.SelectLaunchProfile(id); err != nil {
		return ProfileSwitchResult{}, err
	}
	return result, nil
}

func (e *Engine) Run(parent context.Context, options RunOptions) error {
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return errors.New("RiftOps is already running")
	}
	config := e.config.Clone()
	game := options.Game
	if game == "" || game == model.GameAuto {
		game = config.DefaultGame
	}
	if game == model.GamePrompt || game == model.GameAuto {
		e.mu.Unlock()
		return errors.New("select a game before launching")
	}
	if parsed, err := model.ParseGame(string(game)); err != nil || parsed != game {
		e.mu.Unlock()
		return fmt.Errorf("unsupported game %q", game)
	}
	status := options.Status
	if !status.Valid() {
		status = startupStatus(config)
	}
	// Check per-game status override from the active profile
	if profile := config.ActiveProfile(); profile.GameStatuses != nil {
		if override, ok := profile.GameStatuses[game]; ok && override.Valid() {
			status = override
		}
	}
	e.config.UpdateActiveRuntime(e.config.Enabled, status)
	ctx, cancel := context.WithCancel(parent)
	e.cancel, e.running = cancel, true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		finalConfig := e.config
		e.running = false
		e.cancel = nil
		e.proxy = nil
		e.policy = nil
		e.adapter = nil
		e.mu.Unlock()
		e.emit(Snapshot{Phase: PhaseIdle, Status: finalConfig.Status, Enabled: finalConfig.Enabled, Game: game, Detail: "Ready to launch"})
	}()
	e.emit(e.phaseSnapshot(PhasePreflight, game, "Checking Riot Client and local networking"))

	adapter := platform.New()
	e.mu.Lock()
	e.adapter = adapter
	e.mu.Unlock()
	processes, err := adapter.KnownProcesses(ctx)
	if err != nil {
		return e.fail(game, status, fmt.Errorf("inspect Riot processes: %w", err))
	}
	allowMultiple := hasAllowMultipleClients(options.RiotClientArgs)
	if len(processes) > 0 && !options.StopExisting && !allowMultiple {
		return e.fail(game, status, ErrRiotAlreadyRunning)
	}
	if len(processes) > 0 && options.StopExisting {
		if err := adapter.StopKnownProcesses(ctx); err != nil {
			return e.fail(game, status, err)
		}
		time.Sleep(2 * time.Second)
		processes, err = adapter.KnownProcesses(ctx)
		if err != nil {
			return e.fail(game, status, fmt.Errorf("confirm Riot shutdown: %w", err))
		}
		if len(processes) > 0 {
			return e.fail(game, status, errors.New("Riot Client did not fully exit; saved login was not restored"))
		}
	}
	if e.vault != nil {
		profile := config.ActiveProfile()
		if len(processes) > 0 {
			if _, vaultErr := e.vault.Status(profile.ID); vaultErr == nil {
				return e.fail(game, status, errors.New("close Riot Client before switching to a saved login profile"))
			}
		} else if err := e.vault.Restore(profile.ID); err != nil {
			switch {
			case errors.Is(err, sessionvault.ErrNotFound):
			case errors.Is(err, sessionvault.ErrExpired):
				_ = e.vault.Delete(profile.ID)
				slog.Info("saved Riot login expired; Riot Client will request sign-in", "profile", profile.Name)
			default:
				return e.fail(game, status, fmt.Errorf("restore saved Riot login: %w", err))
			}
		}
	}
	executable, err := resolveRiotClientExecutable(adapter, config.RiotClientPath)
	if err != nil {
		return e.fail(game, status, err)
	}

	e.emit(e.phaseSnapshot(PhasePreparingProxy, game, "Preparing secure local chat proxy"))
	if err := ensureLoopbackEndpoint(ctx, LocalhostDomain); err != nil {
		slog.Warn("public loopback hostname is unavailable; using native Riot chat", "error", err)
		return e.runWithDirectChat(ctx, cancel, adapter, executable, game, options)
	}
	chatListener, err := chatproxy.Listen("127.0.0.1:0")
	if err != nil {
		slog.Warn("local chat listener is unavailable; using native Riot chat", "error", err)
		return e.runWithDirectChat(ctx, cancel, adapter, executable, game, options)
	}
	chatPort := chatListener.Addr().(*net.TCPAddr).Port
	cachePath, err := certificate.DefaultPublicBundleCachePath()
	if err != nil {
		_ = chatListener.Close()
		slog.Warn("public certificate cache is unavailable; using native Riot chat", "error", err)
		return e.runWithDirectChat(ctx, cancel, adapter, executable, game, options)
	}
	serverCertificate, err := (certificate.PublicProvider{CachePath: cachePath, Hostname: LocalhostDomain}).Load(ctx)
	if err != nil {
		_ = chatListener.Close()
		slog.Warn("public loopback certificate is unavailable; using native Riot chat", "error", err)
		return e.runWithDirectChat(ctx, cancel, adapter, executable, game, options)
	}

	e.mu.RLock()
	currentConfig := e.config
	e.mu.RUnlock()
	policy := &runtimePolicy{status: currentConfig.Status, enabled: currentConfig.Enabled, connectToMUC: currentConfig.ConnectToMUC}
	endpoint := &endpointState{}
	proxy := chatproxy.NewProxy(chatListener, serverCertificate, endpoint.get, policy.options)
	e.mu.Lock()
	e.policy = policy
	e.proxy = proxy
	e.mu.Unlock()
	proxy.SetCommandHandler(func(command fakeplayer.Command) {
		e.commandMu.Lock()
		defer e.commandMu.Unlock()
		e.handleCommand(context.Background(), command)
	})
	proxy.SetSessionHandler(func() {
		snapshot := e.phaseSnapshot(PhaseActive, game, "League chat proxy connected")
		snapshot.ChatPort = chatPort
		e.emit(snapshot)
	})
	var connectedNotification sync.Once
	proxy.SetRosterHandler(func() {
		connectedNotification.Do(func() {
			go func() {
				if !currentConfig.IntroductionShown {
					e.sendIntroduction(ctx, proxy)
					return
				}
				snapshot := e.Snapshot()
				message := "RiftOps is active. You are appearing " + humanStatus(snapshot.Status) + "."
				if !snapshot.Enabled {
					message = "RiftOps is connected, but presence masking is disabled."
				}
				e.sendNotification(ctx, proxy, message)
			}()
		})
	})
	configServer, err := configproxy.NewServer(configproxy.ServerOptions{
		LocalChatHost: LocalhostDomain, LocalChatPort: chatPort,
		OnEndpoint: func(value configproxy.Endpoint) {
			endpoint.set(value)
			snapshot := e.phaseSnapshot(PhaseWaiting, game, "Riot chat endpoint found; completing secure handshake")
			snapshot.ChatPort = chatPort
			e.emit(snapshot)
		},
	})
	if err != nil {
		_ = chatListener.Close()
		return e.fail(game, status, err)
	}
	defer configServer.Close(context.Background())
	proxyCtx, stopProxy := context.WithCancel(ctx)
	defer stopProxy()
	go func() {
		if err := configServer.Run(); err != nil {
			slog.Error("config proxy stopped", "error", err)
			cancel()
		}
	}()
	go func() {
		if err := proxy.Run(proxyCtx); err != nil {
			slog.Error("chat proxy stopped", "error", err)
			cancel()
		}
	}()

	launching := e.phaseSnapshot(PhaseLaunching, game, "Launching Riot Client")
	launching.ConfigURL, launching.ChatPort, launching.StartedAt = configServer.URL(), chatPort, time.Now()
	e.emit(launching)
	process, err := adapter.Launch(ctx, platform.LaunchRequest{
		Executable: executable, ConfigURL: configServer.URL(), Game: game, Patchline: options.Patchline,
		RiotClientArgs: options.RiotClientArgs, GameArgs: options.GameArgs,
	})
	if err != nil {
		return e.fail(game, status, err)
	}
	waiting := e.phaseSnapshot(PhaseWaiting, game, "Waiting for Riot chat connection")
	waiting.ConfigURL, waiting.ChatPort, waiting.StartedAt = configServer.URL(), chatPort, launching.StartedAt
	e.emit(waiting)

	processDone := make(chan error, 1)
	go func() { processDone <- process.Wait() }()
	select {
	case <-ctx.Done():
		_ = process.Kill()
		return nil
	case handshakeErr := <-proxy.TLSFailures():
		slog.Warn("Riot rejected the local presence proxy; restarting with native Riot chat", "error", handshakeErr)
		fallback := e.phaseSnapshot(PhaseLaunching, game, "Riot rejected presence proxy; restoring native friends and chat")
		fallback.Enabled = false
		e.emit(fallback)
		stopProxy()
		_ = configServer.Close(context.Background())
		stopCtx, stop := context.WithTimeout(context.Background(), 20*time.Second)
		if stopErr := adapter.StopKnownProcesses(stopCtx); stopErr != nil {
			stop()
			return e.fail(game, status, fmt.Errorf("stop Riot Client for native-chat fallback: %w", stopErr))
		}
		if stopErr := waitForNoRiotProcesses(stopCtx, adapter); stopErr != nil {
			stop()
			return e.fail(game, status, stopErr)
		}
		stop()
		e.mu.Lock()
		e.proxy = nil
		e.policy = nil
		e.mu.Unlock()
		return e.runWithDirectChat(ctx, cancel, adapter, executable, game, options)
	case err := <-processDone:
		if err != nil {
			slog.Debug("launched Riot process exited", "error", err)
		}
		return waitForRiotShutdown(ctx, adapter)
	}
}

func (e *Engine) runWithDirectChat(ctx context.Context, cancel context.CancelFunc, adapter platform.Adapter, executable string, game model.Game, options RunOptions) error {
	e.mu.Lock()
	e.proxy = nil
	e.policy = nil
	e.mu.Unlock()

	configServer, err := configproxy.NewServer(configproxy.ServerOptions{PassThroughChat: true})
	if err != nil {
		return e.fail(game, e.Snapshot().Status, err)
	}
	defer configServer.Close(context.Background())
	go func() {
		if runErr := configServer.Run(); runErr != nil {
			slog.Error("native chat config forwarder stopped", "error", runErr)
			cancel()
		}
	}()

	launching := e.phaseSnapshot(PhaseLaunching, game, "Launching Riot Client with native friends and chat")
	launching.ConfigURL, launching.StartedAt = configServer.URL(), time.Now()
	launching.Enabled = false
	e.emit(launching)
	process, err := adapter.Launch(ctx, platform.LaunchRequest{
		Executable: executable, ConfigURL: configServer.URL(), Game: game, Patchline: options.Patchline,
		RiotClientArgs: options.RiotClientArgs, GameArgs: options.GameArgs,
	})
	if err != nil {
		return e.fail(game, e.Snapshot().Status, err)
	}
	active := e.phaseSnapshot(PhaseActive, game, "Native Riot friends and chat active; presence masking unavailable")
	active.ConfigURL, active.StartedAt, active.Enabled = configServer.URL(), launching.StartedAt, false
	e.emit(active)

	processDone := make(chan error, 1)
	go func() { processDone <- process.Wait() }()
	select {
	case <-ctx.Done():
		_ = process.Kill()
		return nil
	case err := <-processDone:
		if err != nil {
			slog.Debug("launched Riot process exited", "error", err)
		}
		return waitForRiotShutdown(ctx, adapter)
	}
}

func (e *Engine) Stop() {
	e.mu.RLock()
	cancel := e.cancel
	snapshot := e.snapshot
	adapter := e.adapter
	e.mu.RUnlock()
	if cancel != nil {
		e.emit(Snapshot{Phase: PhaseStopping, Status: snapshot.Status, Enabled: snapshot.Enabled, Game: snapshot.Game, Detail: "Stopping RiftOps and Riot Client"})
		cancel()
		if adapter != nil {
			go func() {
				ctx, stop := context.WithTimeout(context.Background(), 15*time.Second)
				defer stop()
				if err := adapter.StopKnownProcesses(ctx); err != nil {
					slog.Warn("stop Riot processes failed", "error", err)
				}
			}()
		}
	}
}

func (e *Engine) SetStatus(ctx context.Context, status model.Status) error {
	if !status.Valid() {
		return fmt.Errorf("invalid status %q", status)
	}
	e.mu.Lock()
	if e.running && e.proxy == nil {
		e.mu.Unlock()
		return errors.New("presence masking is unavailable while Riot friends and chat use native compatibility mode")
	}
	e.config.UpdateActiveRuntime(true, status)
	policy, proxy := e.policy, e.proxy
	e.snapshot.Status, e.snapshot.Enabled = status, true
	snapshot := e.snapshot
	e.mu.Unlock()
	if policy != nil {
		policy.update(status, true)
	}
	if proxy != nil {
		if err := proxy.UpdateStatus(ctx, status); err != nil {
			return err
		}
	}
	if err := e.saveSettings(); err != nil {
		return err
	}
	e.emit(snapshot)
	e.sendNotification(ctx, proxy, "You are now appearing "+humanStatus(status)+".")
	return nil
}

func (e *Engine) SetEnabled(ctx context.Context, enabled bool) error {
	e.mu.Lock()
	if enabled && e.running && e.proxy == nil {
		e.mu.Unlock()
		return errors.New("presence masking is unavailable while Riot friends and chat use native compatibility mode")
	}
	e.config.UpdateActiveRuntime(enabled, e.config.Status)
	config, policy, proxy := e.config, e.policy, e.proxy
	e.snapshot.Enabled = enabled
	snapshot := e.snapshot
	e.mu.Unlock()
	if policy != nil {
		policy.update(config.Status, enabled)
	}
	if proxy != nil {
		target := config.Status
		if !enabled {
			target = model.StatusOnline
		}
		if err := proxy.UpdateStatus(ctx, target); err != nil {
			return err
		}
	}
	if err := e.saveSettings(); err != nil {
		return err
	}
	e.emit(snapshot)
	message := "RiftOps is now disabled; your presence is unchanged."
	if enabled {
		message = "RiftOps is now enabled. You are appearing " + humanStatus(config.Status) + "."
	}
	e.sendNotification(ctx, proxy, message)
	return nil
}

func (e *Engine) SavePreferences(game model.Game, startup settings.StartupStatus, connectToMUC, checkUpdates bool) error {
	e.mu.Lock()
	updated := e.config.Clone()
	updated.UpdateActivePreferences(game, startup, connectToMUC)
	updated.CheckUpdates = checkUpdates
	if err := updated.Validate(); err != nil {
		e.mu.Unlock()
		return err
	}
	e.config = updated
	policy := e.policy
	e.mu.Unlock()
	if policy != nil {
		policy.setMUC(connectToMUC)
	}
	return e.saveSettings()
}

// SaveRiotClientPath stores a validated machine-local executable location.
// Passing an empty path clears the override and restores automatic discovery.
func (e *Engine) SaveRiotClientPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	resolved := ""
	if path != "" {
		var err error
		resolved, err = platform.ResolveRiotClientExecutable(path)
		if err != nil {
			return "", err
		}
	}
	e.mu.Lock()
	updated := e.config.Clone()
	updated.RiotClientPath = resolved
	if err := updated.Validate(); err != nil {
		e.mu.Unlock()
		return "", err
	}
	e.config = updated
	e.mu.Unlock()
	if err := e.saveSettings(); err != nil {
		return "", err
	}
	return resolved, nil
}

func (e *Engine) MarkUpdatePrompted(version string) error {
	e.mu.Lock()
	e.config.PromptedUpdate = version
	e.mu.Unlock()
	return e.saveSettings()
}

func (e *Engine) MarkIntroductionShown() error {
	e.mu.Lock()
	e.config.IntroductionShown = true
	e.mu.Unlock()
	return e.saveSettings()
}

// SavePhoneAccess persists whether the optional LAN phone listener may run.
func (e *Engine) SavePhoneAccess(enabled bool) error {
	e.mu.Lock()
	updated := e.config.Clone()
	updated.PhoneAccess = enabled
	if err := updated.Validate(); err != nil {
		e.mu.Unlock()
		return err
	}
	e.config = updated
	e.mu.Unlock()
	return e.saveSettings()
}

func (e *Engine) saveSettings() error {
	e.saveMu.Lock()
	defer e.saveMu.Unlock()
	e.mu.RLock()
	config := e.config.Clone()
	e.mu.RUnlock()
	return e.store.Save(config)
}

func (e *Engine) handleCommand(ctx context.Context, command fakeplayer.Command) {
	message := ""
	switch command {
	case fakeplayer.CommandOnline, fakeplayer.CommandOffline, fakeplayer.CommandMobile:
		status, _ := model.ParseStatus(string(command))
		_ = e.SetStatus(ctx, status)
	case fakeplayer.CommandEnable:
		_ = e.SetEnabled(ctx, true)
	case fakeplayer.CommandDisable:
		_ = e.SetEnabled(ctx, false)
	case fakeplayer.CommandStatus:
		snapshot := e.Snapshot()
		if snapshot.Enabled {
			message = "You are appearing " + humanStatus(snapshot.Status) + "."
		} else {
			message = "RiftOps is disabled; your presence is unchanged."
		}
	case fakeplayer.CommandHelp:
		message = "Commands: online, offline, mobile, enable, disable, status, help"
	}
	e.mu.RLock()
	proxy := e.proxy
	e.mu.RUnlock()
	if proxy != nil && message != "" {
		_ = proxy.SendFakeMessage(ctx, message)
	}
}

func (e *Engine) sendIntroduction(ctx context.Context, proxy *chatproxy.Proxy) {
	snapshot := e.Snapshot()
	messages := []string{
		"Welcome! RiftOps is active and you are appearing " + humanStatus(snapshot.Status) + ".",
		"Send online, offline, or mobile to change how you appear.",
		"Send enable, disable, status, or help for more controls.",
		"You can also use the RiftOps tray icon or dashboard.",
	}
	for _, message := range messages {
		if err := proxy.SendFakeMessage(ctx, message); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
	if err := e.MarkIntroductionShown(); err != nil {
		slog.Warn("save introduction state failed", "error", err)
	}
}

func (e *Engine) sendNotification(ctx context.Context, proxy *chatproxy.Proxy, message string) {
	if proxy == nil || message == "" {
		return
	}
	if err := proxy.SendFakeMessage(ctx, message); err != nil {
		slog.Debug("in-game notification was not delivered", "error", err)
		return
	}
	slog.Debug("sent in-game RiftOps notification")
}

func (e *Engine) emit(snapshot Snapshot) {
	e.mu.Lock()
	if snapshot.StartedAt.IsZero() {
		snapshot.StartedAt = e.snapshot.StartedAt
	}
	e.snapshot = snapshot
	e.mu.Unlock()
	slog.Debug("state changed", "phase", snapshot.Phase, "game", snapshot.Game, "status", snapshot.Status, "enabled", snapshot.Enabled)
	select {
	case e.events <- snapshot:
	default:
	}
}

func (e *Engine) phaseSnapshot(phase Phase, game model.Game, detail string) Snapshot {
	e.mu.RLock()
	config := e.config
	e.mu.RUnlock()
	return Snapshot{Phase: phase, Game: game, Status: config.Status, Enabled: config.Enabled, Detail: detail}
}

func (e *Engine) fail(game model.Game, status model.Status, err error) error {
	e.mu.RLock()
	enabled := e.config.Enabled
	status = e.config.Status
	e.mu.RUnlock()
	e.emit(Snapshot{Phase: PhaseError, Game: game, Status: status, Enabled: enabled, Detail: err.Error()})
	return err
}

type runtimePolicy struct {
	mu                    sync.RWMutex
	status                model.Status
	enabled, connectToMUC bool
}

func (p *runtimePolicy) options() presence.Options {
	p.mu.RLock()
	defer p.mu.RUnlock()
	status := p.status
	if !p.enabled {
		status = model.StatusOnline
	}
	return presence.Options{Status: status, ConnectToMUC: p.connectToMUC}
}
func (p *runtimePolicy) update(status model.Status, enabled bool) {
	p.mu.Lock()
	p.status, p.enabled = status, enabled
	p.mu.Unlock()
}
func (p *runtimePolicy) setMUC(value bool) { p.mu.Lock(); p.connectToMUC = value; p.mu.Unlock() }

type endpointState struct {
	mu       sync.RWMutex
	endpoint configproxy.Endpoint
	ready    bool
}

func (s *endpointState) set(value configproxy.Endpoint) {
	s.mu.Lock()
	s.endpoint, s.ready = value, true
	s.mu.Unlock()
}
func (s *endpointState) get() (configproxy.Endpoint, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.endpoint, s.ready
}

func startupStatus(config settings.Settings) model.Status {
	if config.StartupStatus == settings.StartupLast {
		return config.Status
	}
	status, err := model.ParseStatus(string(config.StartupStatus))
	if err != nil {
		return model.StatusOffline
	}
	return status
}

func ensureLoopbackEndpoint(ctx context.Context, hostname string) error {
	if ip := net.ParseIP(hostname); ip != nil {
		if ip.IsLoopback() {
			return nil
		}
		return fmt.Errorf("%s is not a loopback address", hostname)
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", hostname, err)
	}
	if len(addresses) == 0 {
		return fmt.Errorf("%s did not resolve to an address", hostname)
	}
	for _, address := range addresses {
		if !address.IP.IsLoopback() {
			return fmt.Errorf("%s resolved to non-loopback address %s", hostname, address.IP)
		}
	}
	return nil
}

func waitForRiotShutdown(ctx context.Context, adapter platform.Adapter) error {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			processes, err := adapter.KnownProcesses(ctx)
			if err != nil {
				return fmt.Errorf("monitor Riot processes: %w", err)
			}
			if len(processes) == 0 {
				return nil
			}
		}
	}
}

func waitForNoRiotProcesses(ctx context.Context, adapter platform.Adapter) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		processes, err := adapter.KnownProcesses(ctx)
		if err != nil {
			return fmt.Errorf("confirm Riot shutdown: %w", err)
		}
		if len(processes) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Riot Client did not fully close: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (e *Engine) waitUntilStopped(ctx context.Context) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		e.mu.RLock()
		running := e.running
		e.mu.RUnlock()
		if !running {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("RiftOps engine did not stop: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func humanStatus(status model.Status) string {
	if status == model.StatusOnline {
		return "online"
	}
	return string(status)
}

func hasAllowMultipleClients(arguments []string) bool {
	for _, argument := range arguments {
		name := strings.SplitN(strings.TrimLeft(strings.TrimSpace(argument), "-"), "=", 2)[0]
		if strings.EqualFold(name, "allow-multiple-clients") {
			return true
		}
	}
	return false
}
