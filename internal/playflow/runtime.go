package playflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/qol"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

type CycleMode string

const (
	CycleSingle CycleMode = "single"
	CycleRepeat CycleMode = "repeat"
)

type Stage string

const (
	StageIdle        Stage = "idle"
	StagePreflight   Stage = "preflight"
	StageLobby       Stage = "lobby"
	StageMatchmaking Stage = "matchmaking"
	StageReadyCheck  Stage = "ready-check"
	StageChampSelect Stage = "champ-select"
	StageInGame      Stage = "in-game"
	StagePostGame    Stage = "post-game"
	StageBlocked     Stage = "blocked"
	StageStopped     Stage = "stopped"
)

type QueueKind string

const (
	QueueRoleBased QueueKind = "role-based"
	QueueRoleless  QueueKind = "roleless"
	QueueArena     QueueKind = "arena"
	QueueARAM      QueueKind = "aram"
	QueuePractice  QueueKind = "practice"
	QueueCustom    QueueKind = "custom"
)

type Status struct {
	Active      bool       `json:"active"`
	RunID       string     `json:"runId,omitempty"`
	CycleMode   CycleMode  `json:"cycleMode"`
	Stage       Stage      `json:"stage"`
	QueueID     int        `json:"queueId,omitempty"`
	QueueKind   QueueKind  `json:"queueKind,omitempty"`
	Message     string     `json:"message"`
	CountdownMS int64      `json:"countdownMs,omitempty"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	StopReason  string     `json:"stopReason,omitempty"`
}

var (
	ErrAlreadyActive = errors.New("play flow runtime is already active")
	ErrInvalidCycle  = errors.New("cycle mode must be single or repeat")
)

// Client is the small LCU surface owned by the Play Flow runtime. Keeping it
// explicit prevents the runtime from becoming a generic LCU proxy and makes
// every mutation deterministic in tests.
type Client interface {
	GetGameflowPhase(context.Context) (string, error)
	FetchGameflowSession(context.Context) ([]byte, error)
	FetchAvailableQueues(context.Context) ([]byte, error)
	FetchCurrentLobby(context.Context) ([]byte, error)
	CreateQueueLobby(context.Context, int) error
	CreateCustomLobby(context.Context, int, string, string, int) error
	CreatePracticeToolLobby(context.Context) error
	AutoSetRoles(context.Context, string, string) error
	AutoRequeue(context.Context) error
	StartCustomGame(context.Context) error
	PlayAgain(context.Context) error
	FetchMatchmakingDiagnostics(context.Context) (riotclient.LCUMatchmakingDiagnostics, []riotclient.LCUMatchmakingError, error)
	FetchLeaverBusterStatus(context.Context) ([]riotclient.LCULeaverNotification, *riotclient.LCURankedRestriction, error)

	GetChampSelectSession(context.Context) ([]byte, error)
	FetchChampSelectPickable(context.Context) ([]byte, error)
	FetchChampSelectBannable(context.Context) ([]byte, error)
	FetchChampSelectSubset(context.Context) ([]byte, error)
	UpdateChampSelectAction(context.Context, int, int, bool) error
	SetCurrentRunePage(context.Context, int) error
	SwapBenchChampion(context.Context, int) error
	FetchChampSelectPickOrderSwaps(context.Context) ([]byte, error)
	UpdateChampSelectSwap(context.Context, string, string, int) error
}

type ClientProvider func() Client
type PreferencesProvider func() qol.PlayFlowPreferences

type Service struct {
	mu          sync.RWMutex
	status      Status
	cancel      context.CancelFunc
	clients     ClientProvider
	preferences PreferencesProvider
	runSequence atomic.Uint64
	now         func() time.Time
	requestWait time.Duration
	champWait   time.Duration
	inGameWait  time.Duration
	onActive    func(bool)
}

// SetActiveChangeHook reports ownership changes to adjacent background
// controllers. The hook must stay non-blocking.
func (s *Service) SetActiveChangeHook(hook func(bool)) {
	s.mu.Lock()
	s.onActive = hook
	s.mu.Unlock()
}

func New(clients ClientProvider, preferences PreferencesProvider) *Service {
	now := time.Now()
	return &Service{
		clients:     clients,
		preferences: preferences,
		now:         time.Now,
		requestWait: 750 * time.Millisecond,
		champWait:   275 * time.Millisecond,
		inGameWait:  2 * time.Second,
		status: Status{
			CycleMode: CycleSingle,
			Stage:     StageIdle,
			Message:   "Full Auto is stopped.",
			UpdatedAt: now,
		},
	}
}

func (s *Service) Status() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func (s *Service) Start(cycleMode CycleMode) (Status, error) {
	if cycleMode != CycleSingle && cycleMode != CycleRepeat {
		return s.Status(), ErrInvalidCycle
	}
	s.mu.Lock()
	if s.status.Active {
		status := s.status
		s.mu.Unlock()
		return status, ErrAlreadyActive
	}
	prefs := qol.DefaultPlayFlowPreferences()
	if s.preferences != nil {
		prefs = s.preferences()
	}
	normalized, err := qol.NormalizePlayFlowPreferences(prefs)
	if err != nil {
		s.mu.Unlock()
		return s.status, fmt.Errorf("invalid Play & Queue settings: %w", err)
	}
	now := s.now().UTC()
	runID := fmt.Sprintf("pf-%d-%d", now.UnixMilli(), s.runSequence.Add(1))
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.status = Status{
		Active:    true,
		RunID:     runID,
		CycleMode: cycleMode,
		Stage:     StagePreflight,
		QueueID:   normalized.SelectedQueue,
		Message:   "Checking League and the selected queue…",
		StartedAt: &now,
		UpdatedAt: now,
	}
	status := s.status
	hook := s.onActive
	s.mu.Unlock()
	if hook != nil {
		hook(true)
	}

	go s.run(ctx, runID, cycleMode, normalized)
	return status, nil
}

// Stop is intentionally idempotent. It cancels RiftOps work only; it never
// cancels matchmaking or dodges an active champion select.
func (s *Service) Stop() Status {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.status.Active {
		s.status.Active = false
		s.status.Stage = StageStopped
		s.status.Message = "Full Auto stopped. League's current queue or draft was left untouched."
		s.status.StopReason = "stopped-by-user"
		s.status.CountdownMS = 0
		s.status.UpdatedAt = s.now().UTC()
	}
	status := s.status
	hook := s.onActive
	s.mu.Unlock()
	if hook != nil {
		hook(false)
	}
	return status
}

type runState struct {
	queueID              int
	queueKind            QueueKind
	queueMeta            queueInfo
	lobbyCreated         bool
	rolesApplied         bool
	matchmakingSubmitted bool
	matchmakingAt        time.Time
	sawSearching         bool
	hadGame              bool
	postGameSince        time.Time
	playAgainSent        bool
	lastPhase            string
	draft                draftRuntime
}

func (s *Service) run(ctx context.Context, runID string, cycleMode CycleMode, prefs qol.PlayFlowPreferences) {
	state := &runState{queueID: prefs.SelectedQueue}
	for {
		wait, keepRunning := s.step(ctx, runID, cycleMode, prefs, state)
		if !keepRunning {
			return
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *Service) step(ctx context.Context, runID string, cycleMode CycleMode, prefs qol.PlayFlowPreferences, state *runState) (time.Duration, bool) {
	if ctx.Err() != nil || !s.isCurrentRun(runID) {
		return 0, false
	}
	client := s.clients()
	if client == nil {
		s.finish(runID, StageBlocked, "League Client disconnected. Full Auto stopped safely.", "league-disconnected")
		return 0, false
	}
	requestCtx, cancel := context.WithTimeout(ctx, 2200*time.Millisecond)
	phase, err := client.GetGameflowPhase(requestCtx)
	cancel()
	if err != nil {
		s.finish(runID, StageBlocked, "League Client stopped responding. Full Auto stopped safely.", "league-unavailable")
		return 0, false
	}
	phase = strings.TrimSpace(phase)
	// Gameflow remains the most reliable queue signal once League has left the
	// lobby. Refresh it on every runtime tick so a stale lobby payload cannot
	// make a role-based, Arena, or ARAM draft take the wrong path.
	if liveQueue, ok := fetchGameflowQueue(ctx, client); ok {
		state.queueMeta = mergeQueueInfo(state.queueMeta, liveQueue)
		if liveQueue.ID > 0 {
			state.queueID = liveQueue.ID
		}
		state.queueKind = classifyQueue(state.queueMeta, state.queueKind == QueueCustom || liveQueue.IsCustom)
	}

	if state.lastPhase == "ChampSelect" && phase != "ChampSelect" {
		state.draft.reset()
	}
	state.lastPhase = phase

	switch phase {
	case "None", "":
		if state.matchmakingSubmitted || state.sawSearching {
			s.finish(runID, StageBlocked, "League left the queue flow. Full Auto stopped without changing the current client state.", "queue-flow-ended")
			return 0, false
		}
		if err := s.ensureLobby(ctx, runID, client, prefs, state); err != nil {
			s.finish(runID, StageBlocked, err.Error(), "preflight-failed")
			return 0, false
		}
		return s.requestWait, true

	case "Lobby":
		if state.hadGame && cycleMode == CycleRepeat {
			state.resetCycle()
		}
		if state.sawSearching {
			s.finish(runID, StageStopped, "Matchmaking or Ready Check was cancelled in League. Full Auto stopped.", "queue-cancelled")
			return 0, false
		}
		if state.matchmakingSubmitted {
			if s.now().Sub(state.matchmakingAt) < 4*time.Second {
				s.update(runID, StageMatchmaking, "League is starting matchmaking…", state, 0)
				return s.requestWait, true
			}
			diagnostics, _, diagnosticErr := s.fetchDiagnostics(ctx, client)
			if diagnosticErr == nil && diagnostics.IsCurrentlyInQueue {
				state.sawSearching = true
				s.update(runID, StageMatchmaking, "Searching for a match…", state, 0)
				return s.requestWait, true
			}
			s.finish(runID, StageBlocked, "League did not confirm matchmaking. Full Auto stopped so it will not submit twice.", "matchmaking-unconfirmed")
			return 0, false
		}
		if err := s.prepareAndStartLobby(ctx, runID, client, prefs, state); err != nil {
			s.finish(runID, StageBlocked, err.Error(), "preflight-failed")
			return 0, false
		}
		return s.requestWait, true

	case "Matchmaking":
		state.sawSearching = true
		if message, blocked := s.matchmakingBlocker(ctx, client, state.queueID); blocked {
			s.finish(runID, StageBlocked, message, "matchmaking-blocked")
			return 0, false
		}
		s.update(runID, StageMatchmaking, "Searching for a match…", state, 0)
		return s.requestWait, true

	case "ReadyCheck":
		state.sawSearching = true
		message := "Ready Check is active."
		if prefs.AutoAccept {
			message = "Ready Check is active. The saved background auto-accept rule is handling it."
		}
		s.update(runID, StageReadyCheck, message, state, 0)
		return s.requestWait, true

	case "ChampSelect":
		state.sawSearching = true
		message, countdown, draftErr := state.draft.step(ctx, client, prefs, state.queueKind, state.queueID, s.now())
		if draftErr != nil {
			s.finish(runID, StageBlocked, draftErr.Error(), "draft-blocked")
			return 0, false
		}
		if message == "" {
			message = "Champion Select is active."
		}
		s.update(runID, StageChampSelect, message, state, countdown)
		return s.champWait, true

	case "GameStart", "Loading", "InProgress", "Reconnect":
		state.hadGame = true
		if cycleMode == CycleSingle {
			s.finish(runID, StageStopped, "Game launched. One-match Full Auto is complete.", "single-match-complete")
			return 0, false
		}
		s.update(runID, StageInGame, "Game in progress. Full Auto will wait for post-game before repeating.", state, 0)
		return s.inGameWait, true

	case "PreEndOfGame", "WaitingForStats", "EndOfGame":
		state.hadGame = true
		if cycleMode == CycleSingle {
			s.finish(runID, StageStopped, "Match completed. One-match Full Auto is stopped.", "single-match-complete")
			return 0, false
		}
		if state.postGameSince.IsZero() {
			state.postGameSince = s.now()
		}
		s.update(runID, StagePostGame, "Waiting for League to return to the lobby…", state, 0)
		if phase == "EndOfGame" && !state.playAgainSent && s.now().Sub(state.postGameSince) >= 1500*time.Millisecond {
			actionCtx, actionCancel := context.WithTimeout(ctx, 2200*time.Millisecond)
			err := client.PlayAgain(actionCtx)
			actionCancel()
			if err == nil {
				state.playAgainSent = true
			}
		}
		return s.requestWait, true

	case "TerminatedInError":
		s.finish(runID, StageBlocked, "League reported a gameflow error. Full Auto stopped.", "gameflow-error")
		return 0, false

	default:
		s.update(runID, StagePreflight, "Waiting for League to reach a queue-ready phase…", state, 0)
		return s.requestWait, true
	}
}

func (s *Service) ensureLobby(ctx context.Context, runID string, client Client, prefs qol.PlayFlowPreferences, state *runState) error {
	if prefs.SelectedQueue <= 0 {
		return errors.New("Use current lobby requires an existing League lobby. Create one in League, then start Full Auto again.")
	}
	if state.lobbyCreated {
		s.update(runID, StageLobby, "Waiting for League to open the selected lobby…", state, 0)
		return nil
	}
	meta, err := s.queueMetadata(ctx, client, prefs.SelectedQueue)
	if err != nil {
		return err
	}
	state.queueMeta = meta
	state.queueID = meta.ID
	state.queueKind = classifyQueue(meta, false)
	s.update(runID, StageLobby, "Creating the selected League lobby…", state, 0)
	actionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	switch state.queueKind {
	case QueuePractice:
		err = client.CreatePracticeToolLobby(actionCtx)
	case QueueCustom:
		err = client.CreateCustomLobby(actionCtx, meta.ID, meta.GameMode, meta.Name, meta.MapID)
	default:
		err = client.CreateQueueLobby(actionCtx, meta.ID)
	}
	if err != nil {
		slog.Info("play flow could not create lobby", "queueId", meta.ID, "error", err)
		return errors.New("League rejected the selected lobby. Refresh the queue list and try again.")
	}
	state.lobbyCreated = true
	return nil
}

func (s *Service) prepareAndStartLobby(ctx context.Context, runID string, client Client, prefs qol.PlayFlowPreferences, state *runState) error {
	lobby, err := fetchLobby(ctx, client)
	if err != nil {
		return errors.New("League's current lobby is unavailable. Full Auto did not start matchmaking.")
	}
	queueID := lobby.GameConfig.QueueID
	if prefs.SelectedQueue > 0 && queueID != prefs.SelectedQueue {
		state.lobbyCreated = false
		if err := s.ensureLobby(ctx, runID, client, prefs, state); err != nil {
			return err
		}
		return nil
	}
	if queueID <= 0 {
		return errors.New("League's lobby does not have a valid queue. Choose a queue and try again.")
	}
	if lobby.LocalMember.IsLeader != nil && !*lobby.LocalMember.IsLeader {
		return errors.New("Only the League lobby leader can start Full Auto.")
	}
	if lobby.LocalMember.AllowedStartActivity != nil && !*lobby.LocalMember.AllowedStartActivity {
		return errors.New("League reports that this account cannot start the lobby activity.")
	}
	if lobby.CanStartActivity != nil && !*lobby.CanStartActivity {
		return errors.New("League reports that the lobby is not ready to start.")
	}
	state.queueID = queueID
	if state.queueMeta.ID != queueID {
		state.queueMeta, _ = s.queueMetadata(ctx, client, queueID)
	}
	state.queueMeta.ID = queueID
	state.queueKind = classifyQueue(state.queueMeta, lobby.IsCustom || lobby.GameConfig.IsCustom || len(lobby.CustomGameLobby) > 0)
	if message, blocked := s.preflightBlocker(ctx, client, state); blocked {
		return errors.New(message)
	}
	if state.queueKind == QueueRoleBased && !state.rolesApplied {
		s.update(runID, StagePreflight, "Applying lane preferences…", state, 0)
		actionCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		err = client.AutoSetRoles(actionCtx, prefs.PrimaryRole, prefs.SecondaryRole)
		cancel()
		if err != nil {
			slog.Info("play flow could not apply roles", "first", prefs.PrimaryRole, "second", prefs.SecondaryRole, "error", err)
			return errors.New("League rejected the selected lanes. Full Auto stopped before matchmaking.")
		}
		state.rolesApplied = true
	}
	s.update(runID, StageLobby, "Starting the selected queue…", state, 0)
	actionCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	if state.queueKind == QueueCustom || state.queueKind == QueuePractice {
		err = client.StartCustomGame(actionCtx)
	} else {
		err = client.AutoRequeue(actionCtx)
	}
	cancel()
	if err != nil {
		slog.Info("play flow start rejected", "queueId", state.queueID, "kind", state.queueKind, "error", err)
		return errors.New("League rejected the queue start. Full Auto did not retry the request.")
	}
	state.matchmakingSubmitted = true
	state.matchmakingAt = s.now()
	return nil
}

func (s *Service) preflightBlocker(ctx context.Context, client Client, state *runState) (string, bool) {
	if message, blocked := s.matchmakingBlocker(ctx, client, state.queueID); blocked {
		return message, true
	}
	requestCtx, cancel := context.WithTimeout(ctx, 2200*time.Millisecond)
	notifications, ranked, err := client.FetchLeaverBusterStatus(requestCtx)
	cancel()
	if err != nil {
		return "", false
	}
	for _, notification := range notifications {
		if notification.QueueLockoutTimerExpiryMillisDiff > 0 {
			return "League reports an active queue lockout. Full Auto stopped.", true
		}
	}
	if ranked != nil && ranked.PunishedGamesRemaining > 0 && isRankedQueue(state.queueMeta) {
		return "This account has a ranked restriction. Choose a non-ranked queue or finish the required games first.", true
	}
	return "", false
}

func (s *Service) matchmakingBlocker(ctx context.Context, client Client, queueID int) (string, bool) {
	diagnostics, errorsList, err := s.fetchDiagnostics(ctx, client)
	if err != nil {
		return "", false
	}
	if diagnostics.LowPriorityData != nil && diagnostics.LowPriorityData.PenaltyTimeRemaining > 0 {
		return "League reports an active low-priority penalty. Full Auto stopped.", true
	}
	state := strings.ToLower(strings.TrimSpace(diagnostics.SearchState))
	if state == "error" || state == "serviceerror" || state == "serviceshutdown" || len(errorsList) > 0 {
		message := "League reported a matchmaking error. Full Auto stopped."
		if len(errorsList) > 0 && strings.TrimSpace(errorsList[0].Message) != "" {
			message = "League matchmaking: " + safeMessage(errorsList[0].Message)
		}
		return message, true
	}
	return "", false
}

func (s *Service) fetchDiagnostics(ctx context.Context, client Client) (riotclient.LCUMatchmakingDiagnostics, []riotclient.LCUMatchmakingError, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 2200*time.Millisecond)
	defer cancel()
	return client.FetchMatchmakingDiagnostics(requestCtx)
}

type queueInfo struct {
	ID        int    `json:"id"`
	QueueID   int    `json:"queueId,omitempty"`
	Name      string `json:"name"`
	GameMode  string `json:"gameMode"`
	Category  string `json:"category"`
	MapID     int    `json:"mapId"`
	MapNumber int    `json:"mapNumber,omitempty"`
	IsCustom  bool   `json:"isCustom,omitempty"`
}

// gameflowQueuePayload covers the stable queue-bearing portions of the
// gameflow session while tolerating the nested shapes used across patches.
// The session endpoint is intentionally decoded into this narrow structure so
// unrelated gameflow data never becomes part of the runtime contract.
type gameflowQueuePayload struct {
	ID        int    `json:"id"`
	QueueID   int    `json:"queueId"`
	Name      string `json:"name"`
	GameMode  string `json:"gameMode"`
	Category  string `json:"category"`
	MapID     int    `json:"mapId"`
	MapNumber int    `json:"mapNumber"`
	IsCustom  bool   `json:"isCustom"`
	Map       struct {
		ID int `json:"id"`
	} `json:"map"`
}

type gameflowSessionPayload struct {
	QueueID    int                  `json:"queueId"`
	Name       string               `json:"name"`
	GameMode   string               `json:"gameMode"`
	Category   string               `json:"category"`
	MapID      int                  `json:"mapId"`
	MapNumber  int                  `json:"mapNumber"`
	IsCustom   bool                 `json:"isCustom"`
	Queue      gameflowQueuePayload `json:"queue"`
	GameData   gameflowQueuePayload `json:"gameData"`
	GameConfig gameflowQueuePayload `json:"gameConfig"`
	Map        struct {
		ID int `json:"id"`
	} `json:"map"`
}

type lobbyState struct {
	CanStartActivity *bool           `json:"canStartActivity"`
	IsCustom         bool            `json:"isCustom"`
	CustomGameLobby  json.RawMessage `json:"customGameLobby"`
	GameConfig       struct {
		QueueID  int    `json:"queueId"`
		MapID    int    `json:"mapId"`
		GameMode string `json:"gameMode"`
		IsCustom bool   `json:"isCustom"`
	} `json:"gameConfig"`
	LocalMember struct {
		IsLeader             *bool `json:"isLeader"`
		AllowedStartActivity *bool `json:"allowedStartActivity"`
	} `json:"localMember"`
}

func fetchLobby(ctx context.Context, client Client) (lobbyState, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 2200*time.Millisecond)
	defer cancel()
	body, err := client.FetchCurrentLobby(requestCtx)
	if err != nil {
		return lobbyState{}, err
	}
	var lobby lobbyState
	if err := json.Unmarshal(body, &lobby); err != nil {
		return lobbyState{}, err
	}
	return lobby, nil
}

func (s *Service) queueMetadata(ctx context.Context, client Client, queueID int) (queueInfo, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 2200*time.Millisecond)
	defer cancel()
	body, err := client.FetchAvailableQueues(requestCtx)
	if err != nil {
		return queueInfo{ID: queueID}, nil
	}
	var queues []queueInfo
	if err := json.Unmarshal(body, &queues); err != nil {
		return queueInfo{}, errors.New("League returned an unreadable queue catalogue. Full Auto stopped.")
	}
	for _, queue := range queues {
		if queue.ID == queueID {
			return queue, nil
		}
	}
	return queueInfo{ID: queueID}, nil
}

func fetchGameflowQueue(ctx context.Context, client Client) (queueInfo, bool) {
	requestCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()
	body, err := client.FetchGameflowSession(requestCtx)
	if err != nil {
		return queueInfo{}, false
	}
	var payload gameflowSessionPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return queueInfo{}, false
	}
	info := queueInfo{
		ID:        payload.QueueID,
		Name:      payload.Name,
		GameMode:  payload.GameMode,
		Category:  payload.Category,
		MapID:     payload.MapID,
		MapNumber: payload.MapNumber,
		IsCustom:  payload.IsCustom,
	}
	// A lobby gameConfig can describe the previous/selected lobby while
	// gameData describes the active session. Apply the less-live source first
	// so the active gameflow data wins when both are present.
	for _, nested := range []gameflowQueuePayload{payload.GameConfig, payload.Queue, payload.GameData} {
		info = mergeQueueInfo(info, queueInfo{
			ID:        firstPositive(nested.ID, nested.QueueID),
			Name:      nested.Name,
			GameMode:  nested.GameMode,
			Category:  nested.Category,
			MapID:     firstPositive(nested.MapID, nested.MapNumber, nested.Map.ID),
			MapNumber: nested.MapNumber,
			IsCustom:  nested.IsCustom,
		})
	}
	if info.MapID == 0 {
		info.MapID = payload.Map.ID
	}
	if info.ID == 0 && info.MapID == 0 && strings.TrimSpace(info.GameMode) == "" && !info.IsCustom {
		return queueInfo{}, false
	}
	return info, true
}

func mergeQueueInfo(base, overlay queueInfo) queueInfo {
	if overlay.ID > 0 {
		base.ID = overlay.ID
	}
	if overlay.Name != "" {
		base.Name = overlay.Name
	}
	if overlay.GameMode != "" {
		base.GameMode = overlay.GameMode
	}
	if overlay.Category != "" {
		base.Category = overlay.Category
	}
	if overlay.MapID > 0 {
		base.MapID = overlay.MapID
	}
	if overlay.MapNumber > 0 {
		base.MapNumber = overlay.MapNumber
	}
	if overlay.IsCustom {
		base.IsCustom = true
	}
	return base
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func classifyQueue(queue queueInfo, custom bool) QueueKind {
	mode := strings.ToUpper(strings.TrimSpace(queue.GameMode))
	name := strings.ToUpper(strings.TrimSpace(queue.Name))
	category := strings.ToUpper(strings.TrimSpace(queue.Category))
	if queue.ID == riotclient.PracticeToolQueueID || mode == "PRACTICETOOL" {
		return QueuePractice
	}
	if queue.ID == 1700 || queue.ID == 1710 || queue.ID == 1750 || queue.MapID == 30 || mode == "ARENA" || mode == "CHERRY" || strings.Contains(name, "ARENA") {
		return QueueArena
	}
	if queue.ID == 450 || queue.ID == 2400 || queue.MapID == 12 || mode == "ARAM" || mode == "KIWI" || strings.Contains(name, "ARAM") {
		return QueueARAM
	}
	if custom || category == "CUSTOM" {
		return QueueCustom
	}
	if mode == "CLASSIC" || queue.MapID == 11 || queue.ID == 400 || queue.ID == 420 || queue.ID == 430 || queue.ID == 440 || queue.ID == 490 {
		return QueueRoleBased
	}
	return QueueRoleless
}

func isRankedQueue(queue queueInfo) bool {
	text := strings.ToUpper(queue.Name + " " + queue.Category)
	return queue.ID == 420 || queue.ID == 440 || strings.Contains(text, "RANKED")
}

func (state *runState) resetCycle() {
	state.rolesApplied = false
	state.matchmakingSubmitted = false
	state.matchmakingAt = time.Time{}
	state.sawSearching = false
	state.hadGame = false
	state.postGameSince = time.Time{}
	state.playAgainSent = false
	state.draft.reset()
}

func (s *Service) update(runID string, stage Stage, message string, state *runState, countdown int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.status.Active || s.status.RunID != runID {
		return
	}
	s.status.Stage = stage
	s.status.QueueID = state.queueID
	s.status.QueueKind = state.queueKind
	s.status.Message = message
	s.status.CountdownMS = countdown
	s.status.UpdatedAt = s.now().UTC()
}

func (s *Service) finish(runID string, stage Stage, message, reason string) {
	s.mu.Lock()
	if s.status.RunID != runID {
		s.mu.Unlock()
		return
	}
	s.status.Active = false
	s.status.Stage = stage
	s.status.Message = message
	s.status.StopReason = reason
	s.status.CountdownMS = 0
	s.status.UpdatedAt = s.now().UTC()
	s.cancel = nil
	hook := s.onActive
	s.mu.Unlock()
	if hook != nil {
		hook(false)
	}
}

func (s *Service) isCurrentRun(runID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status.Active && s.status.RunID == runID
}

func safeMessage(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	if len(message) > 180 {
		message = message[:180]
	}
	return message
}
