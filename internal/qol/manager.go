package qol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

// RolePreset stores saved primary/secondary role preferences per queue type.
type RolePreset struct {
	First  string `json:"first"`
	Second string `json:"second"`
}

// Preferences holds all opt-in QoL automations and presets.
type Preferences struct {
	AutoAccept       bool                  `json:"autoAccept"`
	AutoPlayAgain    bool                  `json:"autoPlayAgain"`
	AutoHonor        bool                  `json:"autoHonor"`
	AutoStartQueue   bool                  `json:"autoStartQueue"`
	AutoClaimRewards bool                  `json:"autoClaimRewards"`
	GrindMode        bool                  `json:"grindMode"`
	RolePresets      map[string]RolePreset `json:"rolePresets,omitempty"`
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
	handled := make(map[string]bool) // tracks which automations fired per phase
	cooldowns := make(map[string]time.Time)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prefs := m.Preferences()
			if !prefs.AutoAccept && !prefs.AutoPlayAgain && !prefs.AutoHonor &&
				!prefs.AutoStartQueue && !prefs.AutoClaimRewards && !prefs.GrindMode {
				lastPhase = ""
				handled = make(map[string]bool)
				cooldowns = make(map[string]time.Time)
				continue
			}
			lockfile := riotclient.GetLCULockfile()
			if lockfile == nil {
				lastPhase = ""
				handled = make(map[string]bool)
				cooldowns = make(map[string]time.Time)
				continue
			}
			requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			phase, err := lockfile.GetGameflowPhase(requestCtx)
			cancel()
			if err != nil {
				continue
			}

			// Reset handled map when phase changes
			if phase != lastPhase {
				lastPhase = phase
				handled = make(map[string]bool)
			}

			grind := prefs.GrindMode

			// ── Auto-accept ready check ──
			if (prefs.AutoAccept || grind) && phase == "ReadyCheck" && !handled["accept"] {
				actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
				err = lockfile.AcceptReadyCheck(actionCtx)
				actionCancel()
				if err == nil {
					handled["accept"] = true
					slog.Info("qol: automatically accepted ready check")
				}
			}

			// ── Auto-play-again ──
			if (prefs.AutoPlayAgain || grind) && phase == "EndOfGame" && !handled["playagain"] {
				// Short cooldown: don't fire instantly, wait for post-game screen
				if _, ok := cooldowns["playagain"]; !ok {
					cooldowns["playagain"] = time.Now().Add(3 * time.Second)
				}
				if time.Now().After(cooldowns["playagain"]) {
					actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
					err = lockfile.PlayAgain(actionCtx)
					actionCancel()
					if err == nil {
						handled["playagain"] = true
						slog.Info("qol: automatically returned to lobby")
					}
				}
			}

			// ── Auto-honor first eligible teammate ──
			if (prefs.AutoHonor || grind) && phase == "EndOfGame" && !handled["honor"] {
				if _, ok := cooldowns["honor"]; !ok {
					cooldowns["honor"] = time.Now().Add(5 * time.Second)
				}
				if time.Now().After(cooldowns["honor"]) {
					actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
					honorErr := m.autoHonorFirstTeammate(actionCtx, lockfile)
					actionCancel()
					if honorErr == nil {
						handled["honor"] = true
					}
				}
			}

			// ── Auto-start queue after returning to lobby ──
			if (prefs.AutoStartQueue || grind) && phase == "Lobby" && !handled["startqueue"] {
				// Short delay: wait for lobby to fully form
				if _, ok := cooldowns["startqueue"]; !ok {
					cooldowns["startqueue"] = time.Now().Add(2 * time.Second)
				}
				if time.Now().After(cooldowns["startqueue"]) {
					// A custom/practice lobby is already ready for an explicit
					// Start button. Never replace it with a matchmade queue.
					if m.isCustomLobby(lockfile) {
						handled["startqueue"] = true
						continue
					}
					// Apply role presets if configured for this queue type
					m.applyRolePreset(lockfile, prefs)
					actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
					err = lockfile.AutoRequeue(actionCtx)
					actionCancel()
					if err == nil {
						handled["startqueue"] = true
						slog.Info("qol: automatically started matchmaking")
					}
				}
			}

			// ── Auto-claim event rewards ──
			if (prefs.AutoClaimRewards || grind) && !handled["rewards"] {
				// Fire once per game cycle: after game ends or when returning to lobby
				if phase == "EndOfGame" || phase == "WaitingForStats" || phase == "PreEndOfGame" {
					if _, ok := cooldowns["rewards"]; !ok {
						cooldowns["rewards"] = time.Now().Add(8 * time.Second)
					}
					if time.Now().After(cooldowns["rewards"]) {
						actionCtx, actionCancel := context.WithTimeout(ctx, 4*time.Second)
						claimed, rewardErr := lockfile.ClaimEventRewards(actionCtx)
						actionCancel()
						// Claim is a best-effort, phase-scoped action. Mark it
						// handled even when there are no unclaimed rewards or one
						// event endpoint is unavailable; otherwise the background
						// loop hammers the event service every second.
						handled["rewards"] = true
						if rewardErr == nil {
							slog.Info("qol: auto-claimed event rewards", "count", claimed)
						} else {
							slog.Debug("qol: event reward claim was incomplete", "error", rewardErr, "count", claimed)
						}
					}
				}
			}
		}
	}
}

func (m *Manager) isCustomLobby(lf *riotclient.Lockfile) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	body, err := lf.FetchCurrentLobby(ctx)
	if err != nil {
		return false
	}
	var lobby struct {
		IsCustom        bool            `json:"isCustom"`
		CustomGameLobby json.RawMessage `json:"customGameLobby"`
		GameConfig      struct {
			IsCustom bool   `json:"isCustom"`
			QueueID  int    `json:"queueId"`
			GameMode string `json:"gameMode"`
		} `json:"gameConfig"`
	}
	if json.Unmarshal(body, &lobby) != nil {
		return false
	}
	return lobby.IsCustom || lobby.GameConfig.IsCustom ||
		(len(lobby.CustomGameLobby) > 0 && string(lobby.CustomGameLobby) != "null") ||
		lobby.GameConfig.QueueID == riotclient.PracticeToolQueueID ||
		strings.EqualFold(lobby.GameConfig.GameMode, "PRACTICETOOL")
}

// autoHonorFirstTeammate honors the first eligible ally with the single honor type.
func (m *Manager) autoHonorFirstTeammate(ctx context.Context, lf *riotclient.Lockfile) error {
	ballotBody, err := lf.GetHonorBallot(ctx)
	if err != nil {
		return err
	}
	var ballot struct {
		GameID         uint64 `json:"gameId"`
		EligibleAllies []struct {
			SummonerID uint64 `json:"summonerId"`
			PUUID      string `json:"puuid"`
			GameID     uint64 `json:"gameId"`
		} `json:"eligibleAllies"`
		VotePool *struct {
			Votes int `json:"votes"`
		} `json:"votePool,omitempty"`
	}
	if err := json.Unmarshal(ballotBody, &ballot); err != nil {
		return err
	}
	if len(ballot.EligibleAllies) == 0 {
		return fmt.Errorf("no eligible players to honor")
	}
	if ballot.VotePool != nil && ballot.VotePool.Votes <= 0 {
		return fmt.Errorf("no honor votes remaining")
	}
	// Honor the first eligible ally with the universal honor type
	target := ballot.EligibleAllies[0]
	gameID := target.GameID
	if gameID == 0 {
		gameID = ballot.GameID
	}
	return lf.HonorPlayer(ctx, target.SummonerID, target.PUUID, "HEART", gameID)
}

// applyRolePreset sets saved role preferences for the current queue if configured.
func (m *Manager) applyRolePreset(lf *riotclient.Lockfile, prefs Preferences) {
	if len(prefs.RolePresets) == 0 {
		return
	}
	// Detect current queue type from lobby
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	lobbyBody, err := lf.DoRequest(ctx, "GET", "/lol-lobby/v2/lobby")
	cancel()
	if err != nil {
		return
	}
	var lobby struct {
		GameMode   string `json:"gameMode"`
		QueueID    int    `json:"queueId"`
		IsCustom   bool   `json:"isCustom"`
		GameConfig struct {
			QueueID  int    `json:"queueId"`
			GameMode string `json:"gameMode"`
			IsCustom bool   `json:"isCustom"`
		} `json:"gameConfig"`
		CustomGameLobby json.RawMessage `json:"customGameLobby"`
	}
	if json.Unmarshal(lobbyBody, &lobby) != nil {
		return
	}
	if lobby.IsCustom || lobby.GameConfig.IsCustom || (len(lobby.CustomGameLobby) > 0 && string(lobby.CustomGameLobby) != "null") {
		return
	}
	queueID := lobby.QueueID
	if queueID == 0 {
		queueID = lobby.GameConfig.QueueID
	}
	if queueID == 0 {
		return
	}
	// Map queue ID to preset key
	key := queueIDToKey(queueID)
	if key == "" {
		return
	}
	preset, ok := prefs.RolePresets[key]
	if !ok || preset.First == "" || preset.Second == "" {
		return
	}
	// Apply role preset
	setCtx, setCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer setCancel()
	if err := lf.AutoSetRoles(setCtx, preset.First, preset.Second); err != nil {
		slog.Debug("qol: role preset could not be applied", "queue", key, "error", err)
		return
	}
	slog.Info("qol: applied role preset", "queue", key, "first", preset.First, "second", preset.Second)
}

// queueIDToKey maps Riot queue IDs to human-readable preset keys.
func queueIDToKey(queueID int) string {
	switch queueID {
	case 420:
		return "ranked_solo"
	case 440:
		return "ranked_flex"
	case 400:
		return "normal_draft"
	case 430:
		return "normal_blind"
	case 450:
		return "aram"
	case 1700:
		return "arena"
	case 1300:
		return "swiftplay"
	default:
		return ""
	}
}

// QueueKeys returns the supported queue preset keys sorted.
func QueueKeys() []string {
	keys := []string{"ranked_solo", "ranked_flex", "normal_draft", "normal_blind", "aram", "arena", "swiftplay"}
	sort.Strings(keys)
	return keys
}

// QueueKeyLabels returns a map of queue key → display label.
func QueueKeyLabels() map[string]string {
	return map[string]string{
		"ranked_solo":  "Ranked Solo",
		"ranked_flex":  "Ranked Flex",
		"normal_draft": "Normal Draft",
		"normal_blind": "Normal Blind",
		"aram":         "ARAM",
		"arena":        "Arena",
		"swiftplay":    "Swiftplay",
	}
}
