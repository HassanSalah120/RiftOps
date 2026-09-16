package playflow

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/qol"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

type fakeClient struct {
	mu               sync.Mutex
	phase            string
	lobby            []byte
	queues           []byte
	gameflowSession  []byte
	champSession     []byte
	pickable         []byte
	bannable         []byte
	subset           []byte
	requeueCalls     int
	roleCalls        int
	playAgainCalls   int
	updates          []fakeUpdate
	benchSwaps       []int
	rejectChampion   map[int]bool
	suppressComplete bool
}

type fakeUpdate struct {
	actionID  int
	champion  int
	completed bool
}

func (client *fakeClient) GetGameflowPhase(context.Context) (string, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.phase, nil
}
func (client *fakeClient) FetchGameflowSession(context.Context) ([]byte, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.gameflowSession) == 0 {
		return []byte(`{}`), nil
	}
	return append([]byte(nil), client.gameflowSession...), nil
}
func (client *fakeClient) FetchAvailableQueues(context.Context) ([]byte, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	return append([]byte(nil), client.queues...), nil
}
func (client *fakeClient) FetchCurrentLobby(context.Context) ([]byte, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	return append([]byte(nil), client.lobby...), nil
}
func (client *fakeClient) CreateQueueLobby(context.Context, int) error { return nil }
func (client *fakeClient) CreateCustomLobby(context.Context, int, string, string, int) error {
	return nil
}
func (client *fakeClient) CreatePracticeToolLobby(context.Context) error { return nil }
func (client *fakeClient) AutoSetRoles(context.Context, string, string) error {
	client.mu.Lock()
	client.roleCalls++
	client.mu.Unlock()
	return nil
}
func (client *fakeClient) AutoRequeue(context.Context) error {
	client.mu.Lock()
	client.requeueCalls++
	client.mu.Unlock()
	return nil
}
func (client *fakeClient) StartCustomGame(context.Context) error {
	return client.AutoRequeue(context.Background())
}
func (client *fakeClient) PlayAgain(context.Context) error {
	client.mu.Lock()
	client.playAgainCalls++
	client.mu.Unlock()
	return nil
}
func (client *fakeClient) FetchMatchmakingDiagnostics(context.Context) (riotclient.LCUMatchmakingDiagnostics, []riotclient.LCUMatchmakingError, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	return riotclient.LCUMatchmakingDiagnostics{IsCurrentlyInQueue: client.phase == "Matchmaking", SearchState: "Searching"}, nil, nil
}
func (client *fakeClient) FetchLeaverBusterStatus(context.Context) ([]riotclient.LCULeaverNotification, *riotclient.LCURankedRestriction, error) {
	return nil, nil, nil
}
func (client *fakeClient) GetChampSelectSession(context.Context) ([]byte, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	return append([]byte(nil), client.champSession...), nil
}
func (client *fakeClient) FetchChampSelectPickable(context.Context) ([]byte, error) {
	return append([]byte(nil), client.pickable...), nil
}
func (client *fakeClient) FetchChampSelectBannable(context.Context) ([]byte, error) {
	return append([]byte(nil), client.bannable...), nil
}
func (client *fakeClient) FetchChampSelectSubset(context.Context) ([]byte, error) {
	return append([]byte(nil), client.subset...), nil
}
func (client *fakeClient) UpdateChampSelectAction(_ context.Context, actionID, championID int, completed bool) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.updates = append(client.updates, fakeUpdate{actionID: actionID, champion: championID, completed: completed})
	if client.rejectChampion[championID] {
		return nil
	}
	var session map[string]any
	_ = json.Unmarshal(client.champSession, &session)
	actions, _ := session["actions"].([]any)
	for _, turnValue := range actions {
		turn, _ := turnValue.([]any)
		for _, actionValue := range turn {
			action, _ := actionValue.(map[string]any)
			if int(action["id"].(float64)) == actionID {
				action["championId"] = championID
				if completed {
					action["completed"] = true
				}
			}
		}
	}
	if completed && client.suppressComplete {
		return nil
	}
	client.champSession, _ = json.Marshal(session)
	return nil
}
func (client *fakeClient) SetCurrentRunePage(context.Context, int) error { return nil }
func (client *fakeClient) SwapBenchChampion(_ context.Context, championID int) error {
	client.mu.Lock()
	client.benchSwaps = append(client.benchSwaps, championID)
	client.mu.Unlock()
	return nil
}
func (client *fakeClient) FetchChampSelectPickOrderSwaps(context.Context) ([]byte, error) {
	return []byte(`[]`), nil
}
func (client *fakeClient) UpdateChampSelectSwap(context.Context, string, string, int) error {
	return nil
}

func (client *fakeClient) setPhase(phase string) {
	client.mu.Lock()
	client.phase = phase
	client.mu.Unlock()
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not reached before timeout")
}

func TestSingleRuntimeStartsOnceAndStopsWhenGameLaunches(t *testing.T) {
	client := &fakeClient{
		phase:  "Lobby",
		lobby:  []byte(`{"canStartActivity":true,"gameConfig":{"queueId":420,"gameMode":"CLASSIC","mapId":11},"localMember":{"isLeader":true,"allowedStartActivity":true}}`),
		queues: []byte(`[{"id":420,"name":"Ranked Solo","gameMode":"CLASSIC","mapId":11}]`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.SelectedQueue = 420
	service := New(func() Client { return client }, func() qol.PlayFlowPreferences { return prefs })
	service.requestWait = 15 * time.Millisecond
	t.Cleanup(func() { service.Stop() })

	if _, err := service.Start(CycleSingle); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		client.mu.Lock()
		defer client.mu.Unlock()
		return client.requeueCalls == 1 && client.roleCalls == 1
	})
	client.setPhase("GameStart")
	waitFor(t, time.Second, func() bool { return !service.Status().Active })
	status := service.Status()
	if status.StopReason != "single-match-complete" || status.Stage != StageStopped {
		t.Fatalf("status = %#v", status)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.requeueCalls != 1 {
		t.Fatalf("matchmaking calls = %d, want 1", client.requeueCalls)
	}
}

func TestRepeatRuntimeStaysActiveInGameAndStopIsIdempotent(t *testing.T) {
	client := &fakeClient{phase: "GameStart"}
	service := New(func() Client { return client }, qol.DefaultPlayFlowPreferences)
	service.requestWait = 15 * time.Millisecond
	if _, err := service.Start(CycleRepeat); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool { return service.Status().Stage == StageInGame })
	if !service.Status().Active {
		t.Fatal("repeat runtime stopped when the game launched")
	}
	first := service.Stop()
	second := service.Stop()
	if first.Active || second.Active || first.StopReason != "stopped-by-user" || second.StopReason != "stopped-by-user" {
		t.Fatalf("stop statuses = %#v / %#v", first, second)
	}
}

func TestRepeatRuntimeReturnsToLobbyAndStartsOneNextCycle(t *testing.T) {
	client := &fakeClient{
		phase:  "GameStart",
		lobby:  []byte(`{"canStartActivity":true,"gameConfig":{"queueId":420,"gameMode":"CLASSIC","mapId":11},"localMember":{"isLeader":true,"allowedStartActivity":true}}`),
		queues: []byte(`[{"id":420,"name":"Ranked Solo","gameMode":"CLASSIC","mapId":11}]`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.SelectedQueue = 420
	service := New(func() Client { return client }, func() qol.PlayFlowPreferences { return prefs })
	service.requestWait = 10 * time.Millisecond
	service.inGameWait = 10 * time.Millisecond
	base := time.Now().UTC()
	var offsetMS atomic.Int64
	service.now = func() time.Time { return base.Add(time.Duration(offsetMS.Load()) * time.Millisecond) }
	t.Cleanup(func() { service.Stop() })

	if _, err := service.Start(CycleRepeat); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool { return service.Status().Stage == StageInGame })
	client.setPhase("EndOfGame")
	offsetMS.Store(2_000)
	waitFor(t, time.Second, func() bool { return service.Status().Stage == StagePostGame })
	offsetMS.Store(4_000)
	waitFor(t, time.Second, func() bool {
		client.mu.Lock()
		defer client.mu.Unlock()
		return client.playAgainCalls == 1
	})
	client.setPhase("Lobby")
	waitFor(t, time.Second, func() bool {
		client.mu.Lock()
		defer client.mu.Unlock()
		return client.requeueCalls == 1
	})
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.playAgainCalls != 1 || client.requeueCalls != 1 {
		t.Fatalf("repeat calls = playAgain %d, requeue %d", client.playAgainCalls, client.requeueCalls)
	}
}

func TestStartRejectsDuplicateRuns(t *testing.T) {
	client := &fakeClient{phase: "GameStart"}
	service := New(func() Client { return client }, qol.DefaultPlayFlowPreferences)
	t.Cleanup(func() { service.Stop() })
	if _, err := service.Start(CycleRepeat); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Start(CycleSingle); err != ErrAlreadyActive {
		t.Fatalf("duplicate start error = %v, want %v", err, ErrAlreadyActive)
	}
}

func TestQueueClassificationCoversCurrentArenaAndARAMModes(t *testing.T) {
	if got := classifyQueue(queueInfo{ID: 1750, GameMode: "CHERRY", MapID: 30}, false); got != QueueArena {
		t.Fatalf("Arena queue kind = %q", got)
	}
	if got := classifyQueue(queueInfo{ID: 2400, GameMode: "KIWI", MapID: 12}, false); got != QueueARAM {
		t.Fatalf("ARAM queue kind = %q", got)
	}
	for _, queueID := range []int{3200, 3210, 3220, 3230, 3270} {
		if got := classifyQueue(queueInfo{ID: queueID}, true); got != QueueARAM {
			t.Fatalf("custom ARAM queue %d kind = %q", queueID, got)
		}
	}
}

func TestARAMPlaceholderBanNeverUsesGlobalBanPlan(t *testing.T) {
	client := &fakeClient{
		bannable: []byte(`[-1]`),
		champSession: []byte(`{
			"id":"aram-placeholder-ban","queueId":3210,"localPlayerCellId":0,
			"actions":[[{"id":1,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"ban"}]],
			"myTeam":[{"cellId":0,"championId":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.BanChampionID = 555
	prefs.AutoBan = true
	var runtime draftRuntime
	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3210, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(message), "aram") || !strings.Contains(strings.ToLower(message), "ban") {
		t.Fatalf("message = %q, want explicit ARAM ban status", message)
	}
	if len(client.updates) != 0 {
		t.Fatalf("ARAM placeholder ban mutated the session: %#v", client.updates)
	}
}

func TestARAMMissingCardsDoesNotUseGlobalPickPlan(t *testing.T) {
	client := &fakeClient{
		pickable: []byte(`[40]`),
		subset:   []byte(`[]`),
		champSession: []byte(`{
			"id":"aram-no-cards","queueId":3210,"localPlayerCellId":0,
			"actions":[[{"id":2,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"championId":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PickChampionID = 40
	prefs.AutoPick = true
	var runtime draftRuntime
	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3210, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(message), "aram") || !strings.Contains(strings.ToLower(message), "card") {
		t.Fatalf("message = %q, want ARAM card wait status", message)
	}
	if len(client.updates) != 0 {
		t.Fatalf("ARAM used a non-card global plan: %#v", client.updates)
	}
}

func TestARAMPrioritySelectsLiveCardWithoutReroll(t *testing.T) {
	client := &fakeClient{
		subset: []byte(`[53,40]`),
		champSession: []byte(`{
			"id":"aram-cards","queueId":3210,"localPlayerCellId":0,
			"actions":[[{"id":3,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"championId":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.ARAMChampionPriority = []int{40, 53}
	prefs.AutoPick = true
	var runtime draftRuntime
	if _, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3210, time.Now()); err != nil {
		t.Fatal(err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.updates) != 2 || client.updates[0].champion != 40 || client.updates[0].completed || !client.updates[1].completed {
		t.Fatalf("ARAM card updates = %#v, want one hover and one lock for priority champion 40", client.updates)
	}
	if len(client.benchSwaps) != 0 {
		t.Fatalf("ARAM card selection unexpectedly used a bench swap: %#v", client.benchSwaps)
	}
}

func TestARAMManualChampionChangeStopsBenchAutomation(t *testing.T) {
	client := &fakeClient{
		champSession: []byte(`{
			"id":"aram-manual-bench","queueId":3210,"localPlayerCellId":0,
			"actions":[],
			"myTeam":[{"cellId":0,"championId":53}],
			"benchChampions":[{"championId":40}]
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.ARAMChampionPriority = []int{40, 53}
	var runtime draftRuntime
	if message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3210, time.Now()); err != nil || !strings.Contains(message, "Swapping") {
		t.Fatalf("initial bench step = %q, err=%v", message, err)
	}
	client.mu.Lock()
	var session map[string]any
	if err := json.Unmarshal(client.champSession, &session); err != nil {
		client.mu.Unlock()
		t.Fatal(err)
	}
	member := session["myTeam"].([]any)[0].(map[string]any)
	member["championId"] = 22 // player changed the assigned champion manually
	client.champSession, _ = json.Marshal(session)
	client.mu.Unlock()
	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3210, time.Now().Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(message, "Manual ARAM swap detected") {
		t.Fatalf("manual bench message = %q", message)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.benchSwaps) != 1 {
		t.Fatalf("bench automation continued after manual change: %#v", client.benchSwaps)
	}
}

func TestARAMAutoPickOffDoesNotSwapBench(t *testing.T) {
	client := &fakeClient{
		champSession: []byte(`{
			"id":"aram-autopick-off","queueId":3210,"localPlayerCellId":0,
			"actions":[],"myTeam":[{"cellId":0,"championId":53}],
			"benchChampions":[{"championId":40}]
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.AutoPick = false
	prefs.ARAMChampionPriority = []int{40, 53}
	var runtime draftRuntime
	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3210, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(message, "assigned") {
		t.Fatalf("message = %q, want assigned-champion status", message)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.benchSwaps) != 0 {
		t.Fatalf("bench swap ran with auto-pick disabled: %#v", client.benchSwaps)
	}
}

func TestGameflowQueueMetadataUsesNestedLiveQueue(t *testing.T) {
	client := &fakeClient{gameflowSession: []byte(`{
		"gameMode":"CLASSIC",
		"gameData":{"queueId":1750,"gameMode":"CHERRY","mapNumber":30}
	}`)}
	queue, ok := fetchGameflowQueue(context.Background(), client)
	if !ok {
		t.Fatal("expected nested gameflow queue metadata")
	}
	if queue.ID != 1750 || queue.GameMode != "CHERRY" || queue.MapID != 30 {
		t.Fatalf("queue = %#v, want live Arena metadata", queue)
	}
	if got := classifyQueue(queue, false); got != QueueArena {
		t.Fatalf("live queue kind = %q, want Arena", got)
	}
}

func TestCorrectedTimerUsesLCUEpochAndFailsClosed(t *testing.T) {
	now := time.UnixMilli(10_000)
	var session champSession
	session.Timer.AdjustedTimeLeftInPhase = 5_000
	session.Timer.InternalNowInEpochMS = 9_000
	session.Timer.TotalTimeInPhase = 30_000
	remaining, ok := correctedTimerRemaining(session, now)
	if !ok || remaining != 4*time.Second {
		t.Fatalf("remaining = %v, ok = %v", remaining, ok)
	}
	if ready, _, message := lockReady("last-second", 4, champSession{}, now, now); ready || message == "" {
		t.Fatalf("malformed timer did not fail closed: ready=%v message=%q", ready, message)
	}
}

func TestDraftDoesNotMutateCustomBanDuringPlanning(t *testing.T) {
	now := time.UnixMilli(100_000)
	client := &fakeClient{
		bannable: []byte(`[555]`),
		champSession: []byte(`{
			"id":"custom-draft-planning","queueId":3110,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":0,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"ban"}]],
			"myTeam":[{"cellId":0,"championId":0,"championPickIntent":0}],
			"timer":{"phase":"PLANNING","adjustedTimeLeftInPhase":24000,"internalNowInEpochMs":100000,"totalTimeInPhase":24000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.BanChampionID = 555
	prefs.BanTimingMode = "immediate"
	var runtime draftRuntime

	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3110, now)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(message, "ban/pick phase") {
		t.Fatalf("message = %q, want planning wait status", message)
	}
	if len(client.updates) != 0 {
		t.Fatalf("custom planning sent draft mutations: %#v", client.updates)
	}
}

func TestCustomSummonersRiftUsesSelectedRolePickPlan(t *testing.T) {
	client := &fakeClient{
		pickable: []byte(`[40,203]`),
		champSession: []byte(`{
			"id":"custom-role-plan","queueId":3110,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":1,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PickChampionID = 203
	prefs.PrimaryRole = "UTILITY"
	prefs.RoleAwarePicks = true
	prefs.RolePickPlans = map[string]qol.RolePickPlan{
		"UTILITY": {PickChampionID: 40},
	}
	var runtime draftRuntime

	if _, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3110, time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(client.updates) != 1 || client.updates[0].champion != 40 || client.updates[0].completed {
		t.Fatalf("custom pick updates = %#v, want Support plan champion 40 hover", client.updates)
	}
}

func TestCustomFillWaitsWithoutGuessingRoleProfile(t *testing.T) {
	client := &fakeClient{
		pickable: []byte(`[40,37,203]`),
		champSession: []byte(`{
			"id":"custom-fill","queueId":3110,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":1,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PrimaryRole = "FILL"
	prefs.RoleAwarePicks = true
	prefs.RolePickPlans = map[string]qol.RolePickPlan{"UTILITY": {PickChampionID: 40}}
	var runtime draftRuntime

	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3110, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(message, "assign a lane") || len(client.updates) != 0 {
		t.Fatalf("Fill result = message %q, updates %#v; want safe wait without mutation", message, client.updates)
	}
}

func TestCustomRolePlanUsesFallbackWhenPrimaryIsOccupied(t *testing.T) {
	client := &fakeClient{
		pickable: []byte(`[40,37]`),
		champSession: []byte(`{
			"id":"custom-fallback","queueId":3110,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":0,"actorCellId":2,"championId":40,"completed":true,"isInProgress":false,"type":"pick"}], [{"id":1,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PrimaryRole = "UTILITY"
	prefs.RoleAwarePicks = true
	prefs.RolePickPlans = map[string]qol.RolePickPlan{"UTILITY": {PickChampionID: 40, FallbackPickChampionID: 37}}
	var runtime draftRuntime

	if _, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3110, time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(client.updates) != 1 || client.updates[0].champion != 37 || client.updates[0].completed {
		t.Fatalf("fallback result = %#v, want one fallback hover for champion 37", client.updates)
	}
}

func TestDraftDoesNotGuessWhenLivePickableListIsEmpty(t *testing.T) {
	client := &fakeClient{
		pickable: []byte(`[]`),
		champSession: []byte(`{
			"id":"empty-pickable","queueId":3110,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":1,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PrimaryRole = "UTILITY"
	prefs.RoleAwarePicks = true
	prefs.RolePickPlans = map[string]qol.RolePickPlan{"UTILITY": {PickChampionID: 40}}
	var runtime draftRuntime

	message, _, err := runtime.step(context.Background(), client, prefs, QueueCustom, 3110, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(client.updates) != 0 || !strings.Contains(message, "available") {
		t.Fatalf("empty pickable result = message %q, updates %#v; want safe wait", message, client.updates)
	}
}

func TestDraftLocksAtFourSecondsWithoutExtraDelay(t *testing.T) {
	now := time.UnixMilli(100_000)
	client := &fakeClient{
		pickable: []byte(`[103]`),
		champSession: []byte(`{
			"id":"draft-1","queueId":420,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":7,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"MIDDLE","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":4300,"internalNowInEpochMs":100000,"totalTimeInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PickChampionID = 103
	prefs.PickTimingMode = "last-second"
	prefs.PickTimingSeconds = 4
	var runtime draftRuntime
	if _, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, now.Add(350*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.updates) != 2 || client.updates[0].completed || !client.updates[1].completed {
		t.Fatalf("draft updates = %#v, want hover then immediate timed lock", client.updates)
	}
}

func TestDraftBanKeepsItsHoverWhenLeagueAssignsRole(t *testing.T) {
	now := time.UnixMilli(100_000)
	client := &fakeClient{
		bannable: []byte(`[555]`),
		champSession: []byte(`{
			"id":"draft-ban-role","queueId":420,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":1,
			"actions":[[{"id":1,"actorCellId":1,"championId":0,"completed":false,"isInProgress":false,"type":"ban"}]],
			"myTeam":[{"cellId":1,"assignedPosition":"","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":30000,"internalNowInEpochMs":100000,"totalTimeInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.BanChampionID = 555
	prefs.BanTimingMode = "immediate"
	var runtime draftRuntime
	if _, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, now); err != nil {
		t.Fatal(err)
	}

	client.mu.Lock()
	var session map[string]any
	if err := json.Unmarshal(client.champSession, &session); err != nil {
		client.mu.Unlock()
		t.Fatal(err)
	}
	action := session["actions"].([]any)[0].([]any)[0].(map[string]any)
	action["isInProgress"] = true
	member := session["myTeam"].([]any)[0].(map[string]any)
	member["assignedPosition"] = "utility"
	client.champSession, _ = json.Marshal(session)
	client.mu.Unlock()

	message, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.updates) != 2 || client.updates[0].completed || !client.updates[1].completed {
		t.Fatalf("message = %q, updates = %#v; want RiftOps hover followed by ban completion", message, client.updates)
	}
}

func TestDraftNeverOverwritesManualHover(t *testing.T) {
	client := &fakeClient{
		pickable: []byte(`[22,103]`),
		champSession: []byte(`{
			"id":"draft-manual","queueId":420,"localPlayerCellId":0,
			"actions":[[{"id":3,"actorCellId":0,"championId":22,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"TOP","championPickIntent":22}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":10000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PickChampionID = 103
	var runtime draftRuntime
	message, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if message != "Manual champion choice detected. RiftOps is paused for this turn." {
		t.Fatalf("message = %q", message)
	}
	if len(client.updates) != 0 {
		t.Fatalf("manual hover was overwritten: %#v", client.updates)
	}
}

func TestDraftObservesDelayedLockConfirmationWithoutRetry(t *testing.T) {
	client := &fakeClient{
		suppressComplete: true,
		pickable:         []byte(`[103]`),
		champSession: []byte(`{
			"id":"draft-ambiguous","queueId":420,"gameMode":"CLASSIC","mapId":11,"localPlayerCellId":0,
			"actions":[[{"id":8,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"assignedPosition":"MIDDLE","championId":0,"championPickIntent":0}],
			"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":20000,"internalNowInEpochMs":100000,"totalTimeInPhase":30000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.PickChampionID = 103
	prefs.PickTimingMode = "immediate"
	var runtime draftRuntime
	now := time.UnixMilli(100_000)
	for i := 0; i < 2; i++ {
		_, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	client.mu.Lock()
	var session map[string]any
	if err := json.Unmarshal(client.champSession, &session); err != nil {
		client.mu.Unlock()
		t.Fatal(err)
	}
	actions := session["actions"].([]any)
	action := actions[0].([]any)[0].(map[string]any)
	action["completed"] = true
	client.champSession, _ = json.Marshal(session)
	client.mu.Unlock()

	message, _, err := runtime.step(context.Background(), client, prefs, QueueRoleBased, 420, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if message != "Pick locked." {
		t.Fatalf("message = %q, want delayed lock confirmation", message)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.updates) != 2 || client.updates[0].completed || !client.updates[1].completed {
		t.Fatalf("updates = %#v, want one hover and one lock attempt", client.updates)
	}
}

func TestArenaBraveryRejectionFallsThroughToNextPriority(t *testing.T) {
	client := &fakeClient{
		rejectChampion: map[int]bool{arenaBraveryChampionID: true},
		subset:         []byte(`[103]`),
		champSession: []byte(`{
			"id":"arena-1","queueId":1750,"gameMode":"CHERRY","mapId":30,"localPlayerCellId":0,
			"actions":[[{"id":4,"actorCellId":0,"championId":0,"completed":false,"isInProgress":true,"type":"pick"}]],
			"myTeam":[{"cellId":0,"championPickIntent":0}],"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":12000}
		}`),
	}
	prefs := qol.DefaultPlayFlowPreferences()
	prefs.ArenaPickPriority = []qol.ArenaPriorityItem{{Type: "bravery"}, {Type: "champion", ChampionID: 103}, {Type: "firstAvailable"}}
	var runtime draftRuntime
	message, _, err := runtime.step(context.Background(), client, prefs, QueueArena, 1750, time.Now())
	if err != nil || !strings.Contains(message, "rejected Bravery") {
		t.Fatalf("first Arena step message = %q, err = %v", message, err)
	}
	if _, _, err := runtime.step(context.Background(), client, prefs, QueueArena, 1750, time.Now()); err != nil {
		t.Fatal(err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.updates) < 2 || client.updates[0].champion != arenaBraveryChampionID || client.updates[1].champion != 103 {
		t.Fatalf("Arena updates = %#v", client.updates)
	}
}
