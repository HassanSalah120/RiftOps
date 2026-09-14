package qol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
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

// RolePickPlan stores the champion and rune choices used after League assigns
// a concrete lane. FILL is intentionally not a key: League must resolve it to
// an actual lane before the plan can be used.
type RolePickPlan struct {
	PickChampionID         int `json:"pickChampionId"`
	FallbackPickChampionID int `json:"fallbackPickChampionId"`
	PickRunePageID         int `json:"pickRunePageId"`
	FallbackPickRunePageID int `json:"fallbackPickRunePageId"`
}

// PlayFlowPreferences is the validated policy used by Play & Queue. The
// browser keeps its legacy riftops.playFlow copy for compatibility, while the
// backend stores the canonical copy so every mutation starts from validated
// values.
type PlayFlowPreferences struct {
	PrimaryRole            string                  `json:"primaryRole"`
	SecondaryRole          string                  `json:"secondaryRole"`
	PickChampionID         int                     `json:"pickChampionId"`
	FallbackPickChampionID int                     `json:"fallbackPickChampionId"`
	BanChampionID          int                     `json:"banChampionId"`
	FallbackBanChampionID  int                     `json:"fallbackBanChampionId"`
	PickRunePageID         int                     `json:"pickRunePageId"`
	FallbackPickRunePageID int                     `json:"fallbackPickRunePageId"`
	PickTimingMode         string                  `json:"pickTimingMode"`
	PickTimingSeconds      int                     `json:"pickTimingSeconds"`
	BanTimingMode          string                  `json:"banTimingMode"`
	BanTimingSeconds       int                     `json:"banTimingSeconds"`
	SelectedQueue          int                     `json:"selectedQueue"`
	AutoRoles              bool                    `json:"autoRoles"`
	AutoQueue              bool                    `json:"autoQueue"`
	AutoAccept             bool                    `json:"autoAccept"`
	AutoAcceptDelaySeconds int                     `json:"autoAcceptDelaySeconds"`
	AutoAcceptRandomDelay  bool                    `json:"autoAcceptRandomDelay"`
	AutoBan                bool                    `json:"autoBan"`
	AutoPick               bool                    `json:"autoPick"`
	RoleAwarePicks         bool                    `json:"roleAwarePicks"`
	RolePickPlans          map[string]RolePickPlan `json:"rolePickPlans,omitempty"`
	AutoPickOrderToLast    bool                    `json:"autoPickOrderToLast"`
	AutoPickOrderTarget    string                  `json:"autoPickOrderTarget"`
	InstantLock            bool                    `json:"instantLock"`
	AutoRoleQuestLoadout   bool                    `json:"autoRoleQuestLoadout"`
	ArenaBraveryPick       bool                    `json:"arenaBraveryPick"`
}

const MaxPlayFlowTimingSeconds = 60

// NormalizeRolePreset canonicalizes and validates a primary/secondary role
// pair before it is persisted or sent to League.
func NormalizeRolePreset(preset RolePreset) (RolePreset, error) {
	preset.First = strings.ToUpper(strings.TrimSpace(preset.First))
	preset.Second = strings.ToUpper(strings.TrimSpace(preset.Second))
	allowedRoles := map[string]bool{"TOP": true, "JUNGLE": true, "MIDDLE": true, "BOTTOM": true, "UTILITY": true, "FILL": true}
	if !allowedRoles[preset.First] || !allowedRoles[preset.Second] {
		return preset, fmt.Errorf("roles must be TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY, or FILL")
	}
	if preset.First == preset.Second {
		return preset, fmt.Errorf("primary and secondary roles must be different")
	}
	return preset, nil
}

// DefaultPlayFlowPreferences matches the safe first-run Play & Queue policy.
func DefaultPlayFlowPreferences() PlayFlowPreferences {
	return PlayFlowPreferences{
		PrimaryRole: "TOP", SecondaryRole: "FILL",
		PickTimingMode: "immediate", PickTimingSeconds: 2,
		BanTimingMode: "immediate", BanTimingSeconds: 2,
		AutoRoles: true, AutoQueue: true, AutoAccept: true,
		AutoBan: true, AutoPick: true,
		AutoPickOrderTarget: "latest",
	}
}

// NormalizePlayFlowPreferences trims and bounds a Play & Queue policy. The
// server clamps timing values so callers cannot bypass the UI safety limits.
func NormalizePlayFlowPreferences(preferences PlayFlowPreferences) (PlayFlowPreferences, error) {
	if preferences.PrimaryRole = strings.ToUpper(strings.TrimSpace(preferences.PrimaryRole)); preferences.PrimaryRole == "" {
		preferences.PrimaryRole = "TOP"
	}
	if preferences.SecondaryRole = strings.ToUpper(strings.TrimSpace(preferences.SecondaryRole)); preferences.SecondaryRole == "" {
		preferences.SecondaryRole = "FILL"
	}
	roles, err := NormalizeRolePreset(RolePreset{First: preferences.PrimaryRole, Second: preferences.SecondaryRole})
	if err != nil {
		return preferences, err
	}
	preferences.PrimaryRole, preferences.SecondaryRole = roles.First, roles.Second
	if preferences.PickTimingMode == "" {
		preferences.PickTimingMode = "immediate"
	}
	if preferences.BanTimingMode == "" {
		preferences.BanTimingMode = "immediate"
	}
	allowedTiming := map[string]bool{"immediate": true, "last-second": true, "after": true}
	if !allowedTiming[preferences.PickTimingMode] || !allowedTiming[preferences.BanTimingMode] {
		return preferences, fmt.Errorf("timing mode must be immediate, last-second, or after")
	}
	if preferences.SelectedQueue < 0 {
		return preferences, fmt.Errorf("queue id must not be negative")
	}
	for _, value := range []int{
		preferences.PickChampionID, preferences.FallbackPickChampionID,
		preferences.BanChampionID, preferences.FallbackBanChampionID,
		preferences.PickRunePageID, preferences.FallbackPickRunePageID,
	} {
		if value < 0 {
			return preferences, fmt.Errorf("champion and rune ids must not be negative")
		}
	}
	if len(preferences.RolePickPlans) > 5 {
		return preferences, fmt.Errorf("role pick plans must contain only the five playable lanes")
	}
	for role, plan := range preferences.RolePickPlans {
		if role != "TOP" && role != "JUNGLE" && role != "MIDDLE" && role != "BOTTOM" && role != "UTILITY" {
			return preferences, fmt.Errorf("role pick plan %q is not a playable lane", role)
		}
		for _, value := range []int{plan.PickChampionID, plan.FallbackPickChampionID, plan.PickRunePageID, plan.FallbackPickRunePageID} {
			if value < 0 {
				return preferences, fmt.Errorf("role pick champion and rune ids must not be negative")
			}
		}
	}
	if preferences.PickTimingSeconds < 0 {
		preferences.PickTimingSeconds = 0
	} else if preferences.PickTimingSeconds > MaxPlayFlowTimingSeconds {
		preferences.PickTimingSeconds = MaxPlayFlowTimingSeconds
	}
	if preferences.BanTimingSeconds < 0 {
		preferences.BanTimingSeconds = 0
	} else if preferences.BanTimingSeconds > MaxPlayFlowTimingSeconds {
		preferences.BanTimingSeconds = MaxPlayFlowTimingSeconds
	}
	if preferences.AutoAcceptDelaySeconds < 0 {
		preferences.AutoAcceptDelaySeconds = 0
	} else if preferences.AutoAcceptDelaySeconds > MaxAutoAcceptDelaySeconds {
		preferences.AutoAcceptDelaySeconds = MaxAutoAcceptDelaySeconds
	}
	if preferences.AutoPickOrderTarget == "" {
		preferences.AutoPickOrderTarget = "latest"
	}
	if preferences.AutoPickOrderTarget != "latest" && preferences.AutoPickOrderTarget != "pick-1" && preferences.AutoPickOrderTarget != "pick-2" && preferences.AutoPickOrderTarget != "pick-3" && preferences.AutoPickOrderTarget != "pick-4" && preferences.AutoPickOrderTarget != "pick-5" {
		return preferences, fmt.Errorf("auto pick-order target must be latest or pick-1 through pick-5")
	}
	return preferences, nil
}

// Preferences holds all opt-in QoL automations and presets.
type Preferences struct {
	AutoAccept             bool `json:"autoAccept"`
	AutoAcceptDelaySeconds int  `json:"autoAcceptDelaySeconds"`
	AutoAcceptRandomDelay  bool `json:"autoAcceptRandomDelay"`
	AutoPlayAgain          bool `json:"autoPlayAgain"`
	AutoHonor              bool `json:"autoHonor"`
	// AutoStartQueue is retained for stored-preference compatibility. Queue
	// start is owned by Play & Queue and is never executed by this background
	// manager; Play & Queue may use it only during an explicit Full auto run.
	AutoStartQueue   bool                  `json:"autoStartQueue"`
	AutoClaimRewards bool                  `json:"autoClaimRewards"`
	GrindMode        bool                  `json:"grindMode"`
	RolePresets      map[string]RolePreset `json:"rolePresets,omitempty"`
	PlayFlow         *PlayFlowPreferences  `json:"playFlow,omitempty"`
}

// MaxAutoAcceptDelaySeconds is the safety ceiling for the ready-check delay.
// Keep this policy in the backend so API callers and persisted preferences
// cannot configure a delay longer than the UI supports.
const MaxAutoAcceptDelaySeconds = 8

func normalizePreferences(preferences Preferences) Preferences {
	if preferences.AutoAcceptDelaySeconds < 0 {
		preferences.AutoAcceptDelaySeconds = 0
	} else if preferences.AutoAcceptDelaySeconds > MaxAutoAcceptDelaySeconds {
		preferences.AutoAcceptDelaySeconds = MaxAutoAcceptDelaySeconds
	}
	if preferences.PlayFlow != nil {
		if normalized, err := NormalizePlayFlowPreferences(*preferences.PlayFlow); err == nil {
			preferences.PlayFlow = &normalized
		} else {
			// An invalid persisted policy must never be replayed into LCU. Drop
			// only that optional policy and keep the other QoL preferences usable.
			preferences.PlayFlow = nil
		}
	}
	return preferences
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
		manager.preferences = normalizePreferences(manager.preferences)
	} else if !errors.Is(err, os.ErrNotExist) {
		return manager, fmt.Errorf("read QoL preferences: %w", err)
	}
	return manager, nil
}

func (m *Manager) Preferences() Preferences {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return clonePreferences(m.preferences)
}

func clonePreferences(preferences Preferences) Preferences {
	if preferences.RolePresets != nil {
		presets := make(map[string]RolePreset, len(preferences.RolePresets))
		for key, value := range preferences.RolePresets {
			presets[key] = value
		}
		preferences.RolePresets = presets
	}
	if preferences.PlayFlow != nil {
		flow := *preferences.PlayFlow
		if flow.RolePickPlans != nil {
			plans := make(map[string]RolePickPlan, len(flow.RolePickPlans))
			for role, plan := range flow.RolePickPlans {
				plans[role] = plan
			}
			flow.RolePickPlans = plans
		}
		preferences.PlayFlow = &flow
	}
	return preferences
}

func (m *Manager) Update(preferences Preferences) error {
	if preferences.PlayFlow != nil {
		normalized, err := NormalizePlayFlowPreferences(*preferences.PlayFlow)
		if err != nil {
			return err
		}
		preferences.PlayFlow = &normalized
	}
	preferences = clonePreferences(normalizePreferences(preferences))
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
	var readyAcceptAt time.Time
	readyAcceptConfig := struct {
		delaySeconds int
		random       bool
		valid        bool
	}{}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prefs := normalizePreferences(m.Preferences())
			if !prefs.AutoAccept && !prefs.AutoPlayAgain && !prefs.AutoHonor &&
				!prefs.AutoClaimRewards && !prefs.GrindMode {
				lastPhase = ""
				handled = make(map[string]bool)
				cooldowns = make(map[string]time.Time)
				readyAcceptAt = time.Time{}
				readyAcceptConfig.valid = false
				continue
			}
			lockfile := riotclient.GetLCULockfile()
			if lockfile == nil {
				lastPhase = ""
				handled = make(map[string]bool)
				cooldowns = make(map[string]time.Time)
				readyAcceptAt = time.Time{}
				readyAcceptConfig.valid = false
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
				readyAcceptAt = time.Time{}
				readyAcceptConfig.valid = false
			}

			grind := prefs.GrindMode

			// ── Auto-accept ready check ──
			if (prefs.AutoAccept || grind) && phase == "ReadyCheck" && !handled["accept"] {
				now := time.Now()
				delaySeconds := prefs.AutoAcceptDelaySeconds
				if !readyAcceptConfig.valid || readyAcceptAt.IsZero() ||
					readyAcceptConfig.delaySeconds != delaySeconds || readyAcceptConfig.random != prefs.AutoAcceptRandomDelay {
					chosenDelay := delaySeconds
					if prefs.AutoAcceptRandomDelay {
						chosenDelay = rand.Intn(delaySeconds + 1)
					}
					readyAcceptAt = now.Add(time.Duration(chosenDelay) * time.Second)
					readyAcceptConfig = struct {
						delaySeconds int
						random       bool
						valid        bool
					}{delaySeconds: delaySeconds, random: prefs.AutoAcceptRandomDelay, valid: true}
				}
				if now.Before(readyAcceptAt) {
					continue
				}
				actionCtx, actionCancel := context.WithTimeout(ctx, 2*time.Second)
				err = lockfile.AcceptReadyCheck(actionCtx)
				actionCancel()
				if err == nil {
					handled["accept"] = true
					slog.Info("qol: automatically accepted ready check", "delaySeconds", readyAcceptConfig.delaySeconds, "randomDelay", readyAcceptConfig.random)
				}
			} else {
				readyAcceptAt = time.Time{}
				readyAcceptConfig.valid = false
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

			// Queue start is intentionally not owned by this background manager.
			// Returning from a live game must leave the lobby idle until the user
			// presses Start queue in Play & Queue (or explicitly runs Full auto
			// there). Keeping this action out of the always-on loop prevents a
			// saved preference from silently starting the next match.

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
