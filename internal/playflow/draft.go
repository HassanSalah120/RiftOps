package playflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/qol"
)

const (
	arenaBraveryChampionID         = -3
	pendingLockConfirmationTimeout = 5 * time.Second
)

type champAction struct {
	ID           *int   `json:"id"`
	ActorCellID  int    `json:"actorCellId"`
	ChampionID   int    `json:"championId"`
	Completed    bool   `json:"completed"`
	IsInProgress *bool  `json:"isInProgress"`
	Type         string `json:"type"`
}

type champMember struct {
	CellID             int    `json:"cellId"`
	PickTurn           int    `json:"pickTurn"`
	ChampionID         int    `json:"championId"`
	ChampionPickIntent int    `json:"championPickIntent"`
	AssignedPosition   string `json:"assignedPosition"`
	AssignedRole       string `json:"assignedRole"`
	Position           string `json:"position"`
	Role               string `json:"role"`
}

type champSession struct {
	ID                any             `json:"id"`
	GameID            any             `json:"gameId"`
	QueueID           int             `json:"queueId"`
	GameMode          string          `json:"gameMode"`
	GameType          string          `json:"gameType"`
	MapID             int             `json:"mapId"`
	LocalPlayerCellID int             `json:"localPlayerCellId"`
	Actions           [][]champAction `json:"actions"`
	MyTeam            []champMember   `json:"myTeam"`
	BenchChampions    []struct {
		ChampionID int `json:"championId"`
	} `json:"benchChampions"`
	Timer struct {
		Phase                   string  `json:"phase"`
		TimeLeftInPhase         float64 `json:"timeLeftInPhase"`
		TimeLeft                float64 `json:"timeLeft"`
		AdjustedTimeLeftInPhase float64 `json:"adjustedTimeLeftInPhase"`
		InternalNowInEpochMS    float64 `json:"internalNowInEpochMs"`
		TotalTimeInPhase        float64 `json:"totalTimeInPhase"`
		IsInfinite              bool    `json:"isInfinite"`
	} `json:"timer"`
}

type draftAttempt struct {
	key             string
	actionID        int
	actionType      string
	championID      int
	firstSeen       time.Time
	ownHoverID      int
	hoverConfirmed  bool
	mutationBlocked bool
	runeAttempted   bool
	runeWarning     bool
	lockSubmitted   bool
	lockSubmittedAt time.Time
}

type draftRuntime struct {
	sessionKey          string
	attempt             draftAttempt
	manualActions       map[string]bool
	braveryRejected     map[string]bool
	pickOrderHandledKey string
	aramLastChampion    int
	aramRequested       int
	aramManual          bool
	aramSwapAttempted   map[int]bool
}

func (runtime *draftRuntime) reset() {
	*runtime = draftRuntime{}
}

func (runtime *draftRuntime) ensureMaps() {
	if runtime.manualActions == nil {
		runtime.manualActions = map[string]bool{}
	}
	if runtime.braveryRejected == nil {
		runtime.braveryRejected = map[string]bool{}
	}
	if runtime.aramSwapAttempted == nil {
		runtime.aramSwapAttempted = map[int]bool{}
	}
}

func (runtime *draftRuntime) step(ctx context.Context, client Client, prefs qol.PlayFlowPreferences, fallbackKind QueueKind, fallbackQueueID int, now time.Time) (string, int64, error) {
	runtime.ensureMaps()
	session, err := fetchChampSession(ctx, client)
	if err != nil {
		return "Waiting for League's Champion Select session…", 0, nil
	}
	key := champSessionKey(session)
	if key != runtime.sessionKey {
		runtime.reset()
		runtime.ensureMaps()
		runtime.sessionKey = key
	}
	kind := classifyChampSession(session, fallbackKind, fallbackQueueID)
	if runtime.attempt.lockSubmitted {
		return runtime.observeSubmittedLock(session, now), 0, nil
	}
	if prefs.AutoPickOrderToLast {
		runtime.maybeRequestPickOrderSwap(ctx, client, session, prefs.AutoPickOrderTarget)
	}
	if kind == QueueARAM && prefs.AutoPick {
		if message := runtime.maybeSwapARAMBench(ctx, client, session, prefs.ARAMChampionPriority); message != "" {
			return message, 0, nil
		}
	}

	action := currentLocalAction(session)
	if action == nil || action.ID == nil {
		if kind == QueueARAM {
			return "League assigned your ARAM champion. RiftOps will not spend rerolls; preferred bench swaps remain available.", 0, nil
		}
		return "Waiting for your Champion Select action…", 0, nil
	}
	actionType := normalizeActionType(action.Type)
	if actionType != "pick" && actionType != "ban" {
		return "Waiting for a supported pick or ban action…", 0, nil
	}
	// ARAM has no automatic ban phase. Custom ARAM queues can still expose a
	// placeholder ban action, so leave it untouched instead of applying the
	// global ban plan or making the runtime appear stuck.
	if kind == QueueARAM && actionType == "ban" {
		return "ARAM does not use automatic bans. RiftOps left League's placeholder action untouched.", 0, nil
	}
	// Custom Draft exposes the first ban as in-progress during PLANNING, but
	// Riot's team-builder service rejects updates until BAN_PICK while the
	// local LCU still reports HTTP 204. Do not create an attempt or submit a
	// ban until League's authoritative timer reaches the actionable phase.
	timerPhase := strings.ToUpper(strings.TrimSpace(session.Timer.Phase))
	if actionType == "ban" && timerPhase != "BAN_PICK" {
		return "Waiting for League's ban/pick phase before selecting a ban…", 0, nil
	}
	actionKey := fmt.Sprintf("%s:%d:%s", key, *action.ID, actionType)
	role := localAssignedRole(session)
	if kind == QueueCustom && role == "" {
		// Custom lobbies do not assign matchmaking lanes. The role selected in
		// Play & Queue is therefore the user's explicit draft context, unless it
		// is Fill (which must never guess a lane/profile).
		switch prefs.PrimaryRole {
		case "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY":
			role = prefs.PrimaryRole
		}
	}
	contextRole := role
	if actionType == "ban" {
		// Bans are global. League may publish the assigned lane after RiftOps
		// has already hovered a ban, so lane changes must not erase ownership
		// of that hover and misclassify it as a manual choice.
		contextRole = ""
	}
	contextKey := actionKey + ":" + string(kind) + ":" + contextRole
	if runtime.attempt.key != contextKey {
		runtime.attempt = draftAttempt{key: contextKey, actionID: *action.ID, actionType: actionType, firstSeen: now}
	}
	runtime.attempt.actionID = *action.ID
	runtime.attempt.actionType = actionType
	if runtime.manualActions[actionKey] {
		return "Manual champion choice detected. RiftOps is paused for this turn.", 0, nil
	}

	currentIntent := localPickIntent(session, *action.ID)
	if currentIntent > 0 && currentIntent != runtime.attempt.ownHoverID {
		runtime.manualActions[actionKey] = true
		return "Manual champion choice detected. RiftOps is paused for this turn.", 0, nil
	}
	if runtime.attempt.mutationBlocked {
		return "League did not confirm the previous draft request. RiftOps will not retry it automatically.", 0, nil
	}

	if actionType == "ban" && !prefs.AutoBan {
		return "Auto-ban is off. Choose a ban in League.", 0, nil
	}
	if actionType == "pick" && !prefs.AutoPick {
		return "Auto-pick is off. Choose a champion in League.", 0, nil
	}

	available, availableErr := fetchDraftAvailability(ctx, client, kind, actionType)
	if availableErr != nil {
		if kind == QueueARAM {
			return "League has not published ARAM cards for this action. RiftOps is waiting instead of guessing.", 0, nil
		}
		return "League's live champion choices are unavailable. RiftOps is waiting instead of guessing.", 0, nil
	}
	if len(available) == 0 && kind == QueueARAM {
		return "League has not published ARAM cards for this action. RiftOps is waiting instead of guessing.", 0, nil
	}
	if len(available) == 0 && kind != QueueArena {
		return "League's live champion choices are unavailable. RiftOps is waiting instead of guessing.", 0, nil
	}
	occupied := occupiedChampionIDs(session, *action.ID)
	candidate, runePageID, reason := runtime.chooseCandidate(session, prefs, kind, actionType, actionKey, role, available, occupied)
	if candidate == 0 {
		return reason, 0, nil
	}
	if runtime.attempt.championID != candidate {
		runtime.attempt.championID = candidate
		runtime.attempt.ownHoverID = 0
		runtime.attempt.hoverConfirmed = false
		runtime.attempt.runeAttempted = false
		runtime.attempt.runeWarning = false
		runtime.attempt.lockSubmitted = false
	}

	if kind == QueueArena || kind == QueueARAM {
		return runtime.executeSpecialPick(ctx, client, session, action, actionKey, candidate, kind, now)
	}

	if !runtime.attempt.hoverConfirmed {
		if err := runtime.hoverAndConfirm(ctx, client, actionKey, *action.ID, candidate); err != nil {
			return err.Error(), 0, nil
		}
		return fmt.Sprintf("%s %d is hovered. RiftOps is waiting for the configured lock time.", titleAction(actionType), candidate), 0, nil
	}

	if actionType == "pick" && runePageID > 0 && !runtime.attempt.runeAttempted {
		runtime.attempt.runeAttempted = true
		actionCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
		err := client.SetCurrentRunePage(actionCtx, runePageID)
		cancel()
		if err != nil {
			runtime.attempt.runeWarning = true
		}
	}
	if timerPhase != "BAN_PICK" {
		return fmt.Sprintf("%s %d is hovered. Waiting for League's ban/pick phase before locking.", titleAction(actionType), candidate), 0, nil
	}

	mode, seconds := prefs.PickTimingMode, prefs.PickTimingSeconds
	if actionType == "ban" {
		mode, seconds = prefs.BanTimingMode, prefs.BanTimingSeconds
	}
	if actionType == "pick" && prefs.InstantLock {
		mode = "immediate"
	}
	ready, countdown, timerReason := lockReady(mode, seconds, session, runtime.attempt.firstSeen, now)
	if !ready {
		message := timerReason
		if message == "" {
			message = fmt.Sprintf("%s %d is hovered. Locking with about %d seconds remaining.", titleAction(actionType), candidate, seconds)
		}
		if runtime.attempt.runeWarning {
			message += " League kept the current rune page."
		}
		return message, countdown, nil
	}
	if action.IsInProgress == nil || !*action.IsInProgress {
		return "Waiting for League to mark this action in progress before locking…", 0, nil
	}
	message, err := runtime.lockAfterRefetch(ctx, client, session, actionKey, *action.ID, actionType, candidate, now)
	if err != nil {
		return "", 0, err
	}
	if runtime.attempt.runeWarning {
		message += " League kept the current rune page."
	}
	return message, 0, nil
}

func (runtime *draftRuntime) observeSubmittedLock(session champSession, now time.Time) string {
	action := actionByID(session, runtime.attempt.actionID)
	if action == nil {
		actionType := runtime.attempt.actionType
		runtime.attempt = draftAttempt{}
		return titleAction(actionType) + " completed. League advanced the draft."
	}
	if action.Completed {
		actionType := runtime.attempt.actionType
		runtime.attempt = draftAttempt{}
		return titleAction(actionType) + " locked."
	}
	if runtime.attempt.lockSubmittedAt.IsZero() || now.Sub(runtime.attempt.lockSubmittedAt) < pendingLockConfirmationTimeout {
		return "Lock submitted. Waiting for League confirmation…"
	}
	runtime.attempt.lockSubmitted = false
	runtime.attempt.mutationBlocked = true
	return "League did not confirm the lock before the confirmation window ended. RiftOps will not submit it twice."
}

func fetchChampSession(ctx context.Context, client Client) (champSession, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()
	body, err := client.GetChampSelectSession(requestCtx)
	if err != nil {
		return champSession{}, err
	}
	var session champSession
	if err := json.Unmarshal(body, &session); err != nil {
		return champSession{}, err
	}
	return session, nil
}

func champSessionKey(session champSession) string {
	if session.GameID != nil {
		return fmt.Sprint(session.GameID)
	}
	if session.ID != nil {
		return fmt.Sprint(session.ID)
	}
	return fmt.Sprintf("q%d:c%d", session.QueueID, session.LocalPlayerCellID)
}

func classifyChampSession(session champSession, fallback QueueKind, fallbackQueueID int) QueueKind {
	queue := queueInfo{ID: session.QueueID, GameMode: session.GameMode, MapID: session.MapID}
	if queue.ID == 0 {
		queue.ID = fallbackQueueID
	}
	if strings.TrimSpace(queue.GameMode) == "" {
		queue.GameMode = session.GameType
	}
	kind := classifyQueue(queue, false)
	if fallback == QueueCustom && (kind == QueueRoleBased || kind == QueueRoleless) {
		// Champion Select omits the lobby's custom flag. Preserve the runtime's
		// verified custom origin while still allowing Arena/ARAM/Practice to win.
		return QueueCustom
	}
	if queue.ID == 0 && queue.MapID == 0 && strings.TrimSpace(queue.GameMode) == "" {
		return fallback
	}
	return kind
}

func normalizeActionType(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.NewReplacer("-", "_", " ", "_").Replace(value)
	switch value {
	case "PICK", "CHAMPION_PICK", "CHAMPIONPICK":
		return "pick"
	case "BAN", "CHAMPION_BAN", "CHAMPIONBAN":
		return "ban"
	default:
		return ""
	}
}

func currentLocalAction(session champSession) *champAction {
	for turnIndex := range session.Actions {
		turn := session.Actions[turnIndex]
		unfinished := false
		for index := range turn {
			if !turn[index].Completed {
				unfinished = true
			}
		}
		if !unfinished {
			continue
		}
		for index := range turn {
			action := &turn[index]
			if !action.Completed && action.ActorCellID == session.LocalPlayerCellID {
				return action
			}
		}
		return nil
	}
	return nil
}

func localMember(session champSession) *champMember {
	for index := range session.MyTeam {
		if session.MyTeam[index].CellID == session.LocalPlayerCellID {
			return &session.MyTeam[index]
		}
	}
	if len(session.MyTeam) > 0 {
		return &session.MyTeam[0]
	}
	return nil
}

func localPickIntent(session champSession, actionID int) int {
	if action := actionByID(session, actionID); action != nil && action.ChampionID != 0 {
		return action.ChampionID
	}
	if member := localMember(session); member != nil {
		if member.ChampionPickIntent != 0 {
			return member.ChampionPickIntent
		}
		return member.ChampionID
	}
	return 0
}

func localAssignedRole(session champSession) string {
	member := localMember(session)
	if member == nil {
		return ""
	}
	for _, raw := range []string{member.AssignedPosition, member.AssignedRole, member.Position, member.Role} {
		value := strings.ToUpper(strings.TrimSpace(raw))
		switch value {
		case "TOP":
			return "TOP"
		case "JUNGLE", "JG":
			return "JUNGLE"
		case "MIDDLE", "MID":
			return "MIDDLE"
		case "BOTTOM", "BOT", "ADC":
			return "BOTTOM"
		case "UTILITY", "SUPPORT", "SUP":
			return "UTILITY"
		}
	}
	return ""
}

func occupiedChampionIDs(session champSession, excludedActionID int) map[int]bool {
	occupied := map[int]bool{}
	for _, turn := range session.Actions {
		for _, action := range turn {
			if action.ID != nil && *action.ID == excludedActionID {
				continue
			}
			if action.ChampionID > 0 {
				occupied[action.ChampionID] = true
			}
		}
	}
	for _, member := range session.MyTeam {
		if member.CellID == session.LocalPlayerCellID {
			continue
		}
		if member.ChampionPickIntent > 0 {
			occupied[member.ChampionPickIntent] = true
		}
	}
	return occupied
}

func fetchDraftAvailability(ctx context.Context, client Client, kind QueueKind, actionType string) ([]int, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()
	var body []byte
	var err error
	if kind == QueueArena || kind == QueueARAM {
		body, err = client.FetchChampSelectSubset(requestCtx)
		if err == nil {
			if ids := parseChampionIDs(body); len(ids) > 0 {
				return ids, nil
			}
		}
		if kind == QueueARAM {
			return nil, err
		}
	}
	if actionType == "ban" {
		body, err = client.FetchChampSelectBannable(requestCtx)
	} else {
		body, err = client.FetchChampSelectPickable(requestCtx)
	}
	if err != nil {
		return nil, err
	}
	return parseChampionIDs(body), nil
}

func parseChampionIDs(body []byte) []int {
	var raw any
	if json.Unmarshal(body, &raw) != nil {
		return nil
	}
	seen := map[int]bool{}
	ids := make([]int, 0)
	var visit func(any)
	visit = func(value any) {
		switch typed := value.(type) {
		case float64:
			id := int(typed)
			if id > 0 && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		case []any:
			for _, item := range typed {
				visit(item)
			}
		case map[string]any:
			for _, key := range []string{"championId", "championID", "id"} {
				if candidate, ok := typed[key]; ok {
					visit(candidate)
					return
				}
			}
		}
	}
	visit(raw)
	return ids
}

func (runtime *draftRuntime) chooseCandidate(session champSession, prefs qol.PlayFlowPreferences, kind QueueKind, actionType, actionKey, role string, available []int, occupied map[int]bool) (int, int, string) {
	availableSet := map[int]bool{}
	for _, id := range available {
		availableSet[id] = true
	}
	allowed := func(id int) bool {
		return id > 0 && !occupied[id] && availableSet[id]
	}
	if actionType == "ban" {
		for _, id := range []int{prefs.BanChampionID, prefs.FallbackBanChampionID} {
			if allowed(id) {
				return id, 0, ""
			}
		}
		return 0, 0, "Neither configured ban is available. RiftOps left the turn open for a manual choice."
	}
	if kind == QueueArena {
		for _, item := range prefs.ArenaPickPriority {
			switch item.Type {
			case "bravery":
				if !runtime.braveryRejected[actionKey] {
					return arenaBraveryChampionID, 0, ""
				}
			case "champion":
				if allowed(item.ChampionID) {
					return item.ChampionID, 0, ""
				}
			case "firstAvailable":
				for _, id := range available {
					if allowed(id) {
						return id, 0, ""
					}
				}
			}
		}
		return 0, 0, "No Arena priority choice is currently available. RiftOps is waiting for League."
	}
	if kind == QueueARAM {
		for _, id := range prefs.ARAMChampionPriority {
			if allowed(id) {
				return id, 0, ""
			}
		}
		for _, id := range available {
			if allowed(id) {
				return id, 0, ""
			}
		}
		return 0, 0, "No ARAM card is currently available. RiftOps will not reroll."
	}
	primary, fallback, primaryRune, fallbackRune := prefs.PickChampionID, prefs.FallbackPickChampionID, prefs.PickRunePageID, prefs.FallbackPickRunePageID
	if prefs.RoleAwarePicks && (kind == QueueRoleBased || kind == QueueCustom) {
		if role == "" {
			return 0, 0, "Waiting for League to assign a lane. RiftOps will not guess for Fill."
		}
		plan, ok := prefs.RolePickPlans[role]
		if !ok || (plan.PickChampionID <= 0 && plan.FallbackPickChampionID <= 0) {
			return 0, 0, fmt.Sprintf("No %s pick plan is configured. RiftOps left the turn open for a manual choice.", role)
		}
		primary, fallback, primaryRune, fallbackRune = plan.PickChampionID, plan.FallbackPickChampionID, plan.PickRunePageID, plan.FallbackPickRunePageID
	}
	if allowed(primary) {
		return primary, primaryRune, ""
	}
	if allowed(fallback) {
		if fallbackRune <= 0 {
			fallbackRune = primaryRune
		}
		return fallback, fallbackRune, ""
	}
	return 0, 0, "Neither configured pick is available. RiftOps left the turn open for a manual choice."
}

func (runtime *draftRuntime) hoverAndConfirm(ctx context.Context, client Client, actionKey string, actionID, championID int) error {
	actionCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	err := client.UpdateChampSelectAction(actionCtx, actionID, championID, false)
	cancel()
	session, readErr := fetchChampSession(ctx, client)
	if readErr == nil {
		if current := actionByID(session, actionID); current != nil && current.ChampionID == championID {
			runtime.attempt.ownHoverID = championID
			runtime.attempt.hoverConfirmed = true
			return nil
		}
		if localPickIntent(session, actionID) == championID {
			runtime.attempt.ownHoverID = championID
			runtime.attempt.hoverConfirmed = true
			return nil
		}
	}
	if err != nil {
		runtime.attempt.mutationBlocked = true
		return errors.New("League did not confirm the hover. RiftOps will not retry an ambiguous request.")
	}
	runtime.attempt.mutationBlocked = true
	return errors.New("League accepted the hover request but did not report the selection. RiftOps will not submit it again.")
}

func (runtime *draftRuntime) lockAfterRefetch(ctx context.Context, client Client, previous champSession, actionKey string, actionID int, actionType string, championID int, now time.Time) (string, error) {
	latest, err := fetchChampSession(ctx, client)
	if err != nil {
		return "Waiting for League to confirm the current action…", nil
	}
	current := currentLocalAction(latest)
	if current == nil || current.ID == nil || *current.ID != actionID || normalizeActionType(current.Type) != actionType {
		return "League advanced the draft action. The stale lock was cancelled.", nil
	}
	if current.IsInProgress == nil || !*current.IsInProgress {
		return "Waiting for League to mark this action in progress before locking…", nil
	}
	intent := localPickIntent(latest, actionID)
	if intent != 0 && intent != championID {
		runtime.manualActions[actionKey] = true
		return "Manual champion choice detected. RiftOps is paused for this turn.", nil
	}
	if current.ChampionID != 0 && current.ChampionID != championID {
		runtime.manualActions[actionKey] = true
		return "Manual champion choice detected. RiftOps is paused for this turn.", nil
	}
	runtime.attempt.lockSubmitted = true
	runtime.attempt.lockSubmittedAt = now
	actionCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	err = client.UpdateChampSelectAction(actionCtx, actionID, championID, true)
	cancel()
	confirmed, readErr := fetchChampSession(ctx, client)
	if readErr == nil {
		if action := actionByID(confirmed, actionID); action == nil || action.Completed {
			return titleAction(actionType) + " locked.", nil
		}
	}
	if err != nil {
		runtime.attempt.lockSubmitted = false
		runtime.attempt.mutationBlocked = true
		return "League did not confirm the lock. RiftOps will not retry an ambiguous request.", nil
	}
	return "Lock submitted. Waiting for League confirmation…", nil
}

func (runtime *draftRuntime) executeSpecialPick(ctx context.Context, client Client, session champSession, action *champAction, actionKey string, championID int, kind QueueKind, now time.Time) (string, int64, error) {
	if action.IsInProgress == nil || !*action.IsInProgress {
		return "Waiting for League to activate the special-mode pick…", 0, nil
	}
	if !runtime.attempt.hoverConfirmed {
		err := runtime.hoverAndConfirm(ctx, client, actionKey, *action.ID, championID)
		if err != nil {
			if kind == QueueArena && championID == arenaBraveryChampionID {
				runtime.braveryRejected[actionKey] = true
				runtime.attempt = draftAttempt{key: runtime.attempt.key, firstSeen: runtime.attempt.firstSeen}
				return "League rejected Bravery. Trying the next Arena priority…", 0, nil
			}
			return err.Error(), 0, nil
		}
	}
	latest, err := fetchChampSession(ctx, client)
	if err != nil {
		return "Waiting for League to confirm the special-mode selection…", 0, nil
	}
	current := currentLocalAction(latest)
	if current == nil || current.ID == nil || *current.ID != *action.ID {
		return "League advanced the special-mode selection.", 0, nil
	}
	if current.ChampionID != championID && localPickIntent(latest, *action.ID) != championID {
		if kind == QueueArena && championID == arenaBraveryChampionID {
			runtime.braveryRejected[actionKey] = true
			runtime.attempt = draftAttempt{key: runtime.attempt.key, firstSeen: runtime.attempt.firstSeen}
			return "League rejected Bravery. Trying the next Arena priority…", 0, nil
		}
		runtime.attempt.mutationBlocked = true
		return "League did not confirm the special-mode selection. RiftOps will not retry it.", 0, nil
	}
	message, lockErr := runtime.lockAfterRefetch(ctx, client, session, actionKey, *action.ID, "pick", championID, now)
	return message, 0, lockErr
}

func actionByID(session champSession, actionID int) *champAction {
	for turnIndex := range session.Actions {
		for actionIndex := range session.Actions[turnIndex] {
			action := &session.Actions[turnIndex][actionIndex]
			if action.ID != nil && *action.ID == actionID {
				return action
			}
		}
	}
	return nil
}

func lockReady(mode string, seconds int, session champSession, firstSeen, now time.Time) (bool, int64, string) {
	seconds = max(1, min(60, seconds))
	switch mode {
	case "immediate":
		return true, 0, ""
	case "after":
		remaining := time.Duration(seconds)*time.Second - now.Sub(firstSeen)
		if remaining <= 0 {
			return true, 0, ""
		}
		return false, remaining.Milliseconds(), fmt.Sprintf("Waiting %d seconds after this action began before locking.", seconds)
	case "last-second":
		remaining, ok := correctedTimerRemaining(session, now)
		if !ok {
			return false, 0, "League's draft timer is unavailable. RiftOps will not guess the lock time."
		}
		threshold := time.Duration(seconds) * time.Second
		if remaining <= 0 {
			return false, 0, "League's draft timer expired before a safe lock could be confirmed."
		}
		// The 350 ms window absorbs one 275 ms poll and normal local LCU latency.
		// If a slow response crosses the threshold, any still-positive remaining
		// time is safer than intentionally missing the action.
		if remaining <= threshold+350*time.Millisecond {
			return true, 0, ""
		}
		return false, (remaining - threshold).Milliseconds(), ""
	default:
		return false, 0, "The configured draft timing is invalid."
	}
}

func correctedTimerRemaining(session champSession, now time.Time) (time.Duration, bool) {
	timer := session.Timer
	if timer.IsInfinite {
		return 24 * time.Hour, true
	}
	remainingMS := timer.AdjustedTimeLeftInPhase
	if remainingMS <= 0 {
		remainingMS = timer.TimeLeftInPhase
	}
	if remainingMS <= 0 {
		remainingMS = timer.TimeLeft
	}
	if remainingMS <= 0 {
		return 0, false
	}
	if timer.TotalTimeInPhase > 0 && remainingMS > timer.TotalTimeInPhase {
		remainingMS = timer.TotalTimeInPhase
	}
	if timer.InternalNowInEpochMS > 0 {
		elapsed := float64(now.UnixMilli()) - timer.InternalNowInEpochMS
		if elapsed > 0 {
			remainingMS -= elapsed
		}
	}
	return time.Duration(remainingMS * float64(time.Millisecond)), remainingMS > 0
}

func (runtime *draftRuntime) maybeSwapARAMBench(ctx context.Context, client Client, session champSession, priority []int) string {
	member := localMember(session)
	if member == nil || member.ChampionID <= 0 {
		return ""
	}
	current := member.ChampionID
	if runtime.aramLastChampion > 0 && current != runtime.aramLastChampion {
		if runtime.aramRequested == current {
			runtime.aramRequested = 0
		} else {
			runtime.aramManual = true
		}
	}
	runtime.aramLastChampion = current
	if runtime.aramManual {
		return "Manual ARAM swap detected. RiftOps stopped bench automation for this session."
	}
	bench := map[int]bool{}
	for _, champion := range session.BenchChampions {
		if champion.ChampionID > 0 {
			bench[champion.ChampionID] = true
		}
	}
	if len(bench) == 0 || len(priority) == 0 {
		return ""
	}
	rank := func(championID int) int {
		for index, id := range priority {
			if id == championID {
				return index
			}
		}
		return len(priority) + 1
	}
	currentRank := rank(current)
	target := 0
	for _, championID := range priority {
		if bench[championID] && rank(championID) < currentRank {
			target = championID
			break
		}
	}
	if target == 0 || runtime.aramSwapAttempted[target] {
		return ""
	}
	runtime.aramSwapAttempted[target] = true
	actionCtx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	err := client.SwapBenchChampion(actionCtx, target)
	cancel()
	if err != nil {
		return "League rejected the preferred ARAM bench swap. RiftOps will not retry it."
	}
	runtime.aramRequested = target
	return fmt.Sprintf("Swapping to preferred ARAM champion %d. Rerolls remain manual.", target)
}

type pickOrderSwap struct {
	ID              int    `json:"id"`
	CellID          int    `json:"cellId"`
	TargetCellID    int    `json:"targetCellId"`
	OtherCellID     int    `json:"otherCellId"`
	RequesterCellID int    `json:"requesterCellId"`
	State           string `json:"state"`
}

func (runtime *draftRuntime) maybeRequestPickOrderSwap(ctx context.Context, client Client, session champSession, targetSetting string) {
	key := champSessionKey(session) + ":" + targetSetting
	if runtime.pickOrderHandledKey == key {
		return
	}
	members := append([]champMember(nil), session.MyTeam...)
	sort.Slice(members, func(i, j int) bool { return members[i].PickTurn < members[j].PickTurn })
	targetCell := -1
	if targetSetting == "latest" {
		for _, member := range members {
			if member.CellID != session.LocalPlayerCellID && member.PickTurn >= 0 {
				targetCell = member.CellID
			}
		}
	} else if strings.HasPrefix(targetSetting, "pick-") {
		turn, _ := strconv.Atoi(strings.TrimPrefix(targetSetting, "pick-"))
		for _, member := range members {
			if member.CellID != session.LocalPlayerCellID && member.PickTurn == turn {
				targetCell = member.CellID
				break
			}
		}
	}
	if targetCell < 0 {
		runtime.pickOrderHandledKey = key
		return
	}
	requestCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	body, err := client.FetchChampSelectPickOrderSwaps(requestCtx)
	cancel()
	if err != nil {
		return
	}
	var swaps []pickOrderSwap
	if json.Unmarshal(body, &swaps) != nil {
		return
	}
	for _, swap := range swaps {
		state := strings.ToUpper(swap.State)
		if strings.Contains(state, "DECLIN") || strings.Contains(state, "CANCEL") || strings.Contains(state, "ACCEPT") {
			continue
		}
		other := swap.TargetCellID
		if other == 0 {
			other = swap.OtherCellID
		}
		if other == 0 && swap.CellID != session.LocalPlayerCellID {
			other = swap.CellID
		}
		if other != targetCell {
			continue
		}
		actionCtx, actionCancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		err = client.UpdateChampSelectSwap(actionCtx, "pick-order", "request", swap.ID)
		actionCancel()
		if err == nil {
			runtime.pickOrderHandledKey = key
		}
		return
	}
}

func titleAction(actionType string) string {
	if actionType == "ban" {
		return "Ban"
	}
	return "Pick"
}
