//go:build desktop

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/qol"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

func TestMergeQoLPreferencesPreservesUnchangedFields(t *testing.T) {
	current := qol.Preferences{
		AutoAccept:     true,
		AutoStartQueue: true,
		AutoHonor:      true,
		RolePresets:    map[string]qol.RolePreset{"ranked": {First: "TOP", Second: "FILL"}},
	}
	patch := map[string]json.RawMessage{"autoAccept": json.RawMessage("false")}
	merged, err := mergeQoLPreferences(current, patch)
	if err != nil {
		t.Fatalf("mergeQoLPreferences() error = %v", err)
	}
	if merged.AutoAccept || !merged.AutoStartQueue || !merged.AutoHonor {
		t.Fatalf("mergeQoLPreferences() reset unchanged fields: %#v", merged)
	}
	if got := merged.RolePresets["ranked"]; got.First != "TOP" || got.Second != "FILL" {
		t.Fatalf("mergeQoLPreferences() reset role presets: %#v", merged.RolePresets)
	}
}

func TestMergeQoLPreferencesRejectsInvalidPatchField(t *testing.T) {
	_, err := mergeQoLPreferences(qol.Preferences{}, map[string]json.RawMessage{"autoAccept": json.RawMessage(`"yes"`)})
	if err == nil {
		t.Fatal("mergeQoLPreferences() accepted a non-boolean autoAccept value")
	}
}

func TestMergeQoLPreferencesClampsAutoAcceptDelay(t *testing.T) {
	merged, err := mergeQoLPreferences(qol.Preferences{}, map[string]json.RawMessage{
		"autoAcceptDelaySeconds": json.RawMessage(`99`),
	})
	if err != nil {
		t.Fatalf("mergeQoLPreferences() error = %v", err)
	}
	if merged.AutoAcceptDelaySeconds != qol.MaxAutoAcceptDelaySeconds {
		t.Fatalf("delay = %d, want %d", merged.AutoAcceptDelaySeconds, qol.MaxAutoAcceptDelaySeconds)
	}

	merged, err = mergeQoLPreferences(qol.Preferences{}, map[string]json.RawMessage{
		"autoAcceptDelaySeconds": json.RawMessage(`-5`),
	})
	if err != nil {
		t.Fatalf("mergeQoLPreferences() error = %v", err)
	}
	if merged.AutoAcceptDelaySeconds != 0 {
		t.Fatalf("negative delay = %d, want 0", merged.AutoAcceptDelaySeconds)
	}
}

func TestMergeQoLPreferencesValidatesAndPersistsPlayFlowPolicy(t *testing.T) {
	current := qol.Preferences{AutoAccept: false, AutoStartQueue: false, AutoAcceptDelaySeconds: 1}
	merged, err := mergeQoLPreferences(current, map[string]json.RawMessage{
		"playFlow": json.RawMessage(`{"primaryRole":" middle ","secondaryRole":"top","pickTimingMode":"after","pickTimingSeconds":999,"autoAccept":true,"autoQueue":true,"autoAcceptDelaySeconds":99,"autoPickOrderToLast":true,"autoPickOrderTarget":"pick-3"}`),
	})
	if err != nil {
		t.Fatalf("mergeQoLPreferences() error = %v", err)
	}
	if merged.PlayFlow == nil {
		t.Fatal("Play & Queue policy was not stored")
	}
	flow := merged.PlayFlow
	if flow.PrimaryRole != "MIDDLE" || flow.SecondaryRole != "TOP" || flow.PickTimingSeconds != qol.MaxPlayFlowTimingSeconds {
		t.Fatalf("normalized policy = %#v", flow)
	}
	if !merged.AutoAccept || !merged.AutoStartQueue || merged.AutoAcceptDelaySeconds != qol.MaxAutoAcceptDelaySeconds {
		t.Fatalf("shared match-flow fields were not synchronized: %#v", merged)
	}
	if !flow.AutoPickOrderToLast {
		t.Fatal("auto pick-order-to-last preference was not persisted")
	}
	if flow.AutoPickOrderTarget != "pick-3" {
		t.Fatalf("auto pick-order target = %q, want pick-3", flow.AutoPickOrderTarget)
	}
}

func TestMergeQoLPreferencesPlayFlowPatchPreservesUnchangedFields(t *testing.T) {
	flow := qol.DefaultPlayFlowPreferences()
	flow.PickChampionID = 103
	current := qol.Preferences{AutoAccept: true, AutoStartQueue: true, AutoAcceptDelaySeconds: 4, PlayFlow: &flow}
	merged, err := mergeQoLPreferences(current, map[string]json.RawMessage{
		"playFlow": json.RawMessage(`{"autoPick":false}`),
	})
	if err != nil {
		t.Fatalf("mergeQoLPreferences() error = %v", err)
	}
	if merged.PlayFlow == nil || merged.PlayFlow.AutoPick || merged.PlayFlow.PickChampionID != 103 || !merged.AutoAccept || !merged.AutoStartQueue || merged.AutoAcceptDelaySeconds != 4 {
		t.Fatalf("partial Play & Queue patch reset fields: %#v", merged)
	}
}

func TestMergeQoLPreferencesPlayFlowRolePlanPatchPreservesOtherRoles(t *testing.T) {
	flow := qol.DefaultPlayFlowPreferences()
	flow.RoleAwarePicks = true
	flow.RolePickPlans = map[string]qol.RolePickPlan{
		"TOP": {PickChampionID: 86, FallbackPickChampionID: 54},
	}
	current := qol.Preferences{PlayFlow: &flow}
	merged, err := mergeQoLPreferences(current, map[string]json.RawMessage{
		"playFlow": json.RawMessage(`{"rolePickPlans":{"JUNGLE":{"pickChampionId":19,"fallbackPickChampionId":32}},"roleAwarePicks":true}`),
	})
	if err != nil {
		t.Fatalf("mergeQoLPreferences() error = %v", err)
	}
	if merged.PlayFlow == nil || !merged.PlayFlow.RoleAwarePicks {
		t.Fatal("role-aware picks were not enabled")
	}
	if merged.PlayFlow.RolePickPlans["TOP"].PickChampionID != 86 || merged.PlayFlow.RolePickPlans["JUNGLE"].FallbackPickChampionID != 32 {
		t.Fatalf("role plans were not merged safely: %#v", merged.PlayFlow.RolePickPlans)
	}
}

func TestMergeQoLPreferencesRejectsInvalidPlayFlowPolicy(t *testing.T) {
	_, err := mergeQoLPreferences(qol.Preferences{}, map[string]json.RawMessage{
		"playFlow": json.RawMessage(`{"pickTimingMode":"untrusted"}`),
	})
	if err == nil {
		t.Fatal("invalid Play & Queue policy was accepted")
	}
}

func TestQoLPreferencesHandlerClampsAutoAcceptDelay(t *testing.T) {
	previous := qolManager
	t.Cleanup(func() { qolManager = previous })
	manager, err := qol.NewManager(filepath.Join(t.TempDir(), "qol.json"))
	if err != nil {
		t.Fatalf("qol.NewManager() error = %v", err)
	}
	qolManager = manager

	recorder := httptest.NewRecorder()
	qolPreferencesHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/qol/preferences", bytes.NewBufferString(`{"autoAcceptDelaySeconds":99}`)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delay POST returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var response qol.Preferences
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode delay POST response: %v", err)
	}
	if response.AutoAcceptDelaySeconds != qol.MaxAutoAcceptDelaySeconds {
		t.Fatalf("response delay = %d, want %d", response.AutoAcceptDelaySeconds, qol.MaxAutoAcceptDelaySeconds)
	}
	if got := manager.Preferences().AutoAcceptDelaySeconds; got != qol.MaxAutoAcceptDelaySeconds {
		t.Fatalf("stored delay = %d, want %d", got, qol.MaxAutoAcceptDelaySeconds)
	}
}

func TestQoLPreferencesHandlerMergesPartialPost(t *testing.T) {
	previous := qolManager
	t.Cleanup(func() { qolManager = previous })
	manager, err := qol.NewManager(filepath.Join(t.TempDir(), "qol.json"))
	if err != nil {
		t.Fatalf("qol.NewManager() error = %v", err)
	}
	if err := manager.Update(qol.Preferences{AutoAccept: true, AutoStartQueue: true, AutoAcceptDelaySeconds: 3, AutoAcceptRandomDelay: true}); err != nil {
		t.Fatalf("manager.Update() error = %v", err)
	}
	qolManager = manager

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/qol/preferences", bytes.NewBufferString(`{"autoAccept":false}`))
	qolPreferencesHandler(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("partial QoL POST returned %d: %s", recorder.Code, recorder.Body.String())
	}
	got := manager.Preferences()
	if got.AutoAccept || !got.AutoStartQueue || got.AutoAcceptDelaySeconds != 3 || !got.AutoAcceptRandomDelay {
		t.Fatalf("partial QoL POST reset unchanged fields: %#v", got)
	}
}

func TestQoLPreferencesHandlerMergesConcurrentPartialPosts(t *testing.T) {
	previous := qolManager
	t.Cleanup(func() { qolManager = previous })
	manager, err := qol.NewManager(filepath.Join(t.TempDir(), "qol.json"))
	if err != nil {
		t.Fatalf("qol.NewManager() error = %v", err)
	}
	qolManager = manager

	var group sync.WaitGroup
	for range 12 {
		group.Add(2)
		go func() {
			defer group.Done()
			recorder := httptest.NewRecorder()
			qolPreferencesHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/qol/preferences", bytes.NewBufferString(`{"autoAccept":true}`)))
			if recorder.Code != http.StatusOK {
				t.Errorf("autoAccept partial POST returned %d", recorder.Code)
			}
		}()
		go func() {
			defer group.Done()
			recorder := httptest.NewRecorder()
			qolPreferencesHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/qol/preferences", bytes.NewBufferString(`{"autoStartQueue":true}`)))
			if recorder.Code != http.StatusOK {
				t.Errorf("autoStartQueue partial POST returned %d", recorder.Code)
			}
		}()
	}
	group.Wait()
	got := manager.Preferences()
	if !got.AutoAccept || !got.AutoStartQueue {
		t.Fatalf("concurrent partial POSTs lost a field: %#v", got)
	}
}

func TestLaunchGameArgsUsesValidatedProfileLocaleOnce(t *testing.T) {
	profile := settings.NewProfile("EUW")
	profile.DefaultGame = model.GameLeague
	profile.GameArgs = []string{"--fullscreen", "--locale=de_DE", "--locale", "fr_FR", "--no-splash"}
	profile.LeagueLocale = "en_US"
	got := launchGameArgs(profile)
	want := []string{"--fullscreen", "--no-splash", "--locale=en_US"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("launchGameArgs() = %#v, want %#v", got, want)
	}
}

func TestLaunchGameArgsKeepsGameArgsWhenLocaleIsAutomatic(t *testing.T) {
	profile := settings.NewProfile("EUW")
	profile.GameArgs = []string{"--fullscreen"}
	profile.LeagueLocale = settings.DefaultLeagueLocale
	if got, want := launchGameArgs(profile), profile.GameArgs; !reflect.DeepEqual(got, want) {
		t.Fatalf("launchGameArgs() = %#v, want %#v", got, want)
	}
}

func TestShouldAttachExistingClientForNativeChat(t *testing.T) {
	if !shouldAttachExistingClient(model.GameRiotClient, 1, false) {
		t.Fatal("expected an already-open Riot Client to use native chat")
	}
	if !shouldAttachExistingClient(model.GameLeague, 1, false) {
		t.Fatal("expected League to reuse the existing Riot Client and launch through LCU")
	}
	if shouldAttachExistingClient(model.GameRiotClient, 0, false) {
		t.Fatal("an absent Riot Client cannot be attached")
	}
	if shouldAttachExistingClient(model.GameRiotClient, 1, true) {
		t.Fatal("restart mode must take precedence over attachment")
	}
}

func TestCustomStartRejectsNonPostBeforeTouchingLCU(t *testing.T) {
	recorder := httptest.NewRecorder()
	lcuCustomStartHandler(recorder, httptest.NewRequest(http.MethodGet, "/api/lcu/custom-start", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET custom start returned %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
}

func TestAutomationHandlersRejectWrongMethodsBeforeTouchingLCU(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		method  string
	}{
		{"auto accept", lcuAutoAcceptHandler, http.MethodGet},
		{"decline ready", lcuDeclineReadyHandler, http.MethodGet},
		{"auto requeue", lcuAutoRequeueHandler, http.MethodGet},
		{"stop queue", lcuStopQueueHandler, http.MethodGet},
		{"auto roles", lcuAutoRolesHandler, http.MethodGet},
		{"quit custom", lcuQuitCustomHandler, http.MethodGet},
		{"launch League", lcuLaunchLeagueHandler, http.MethodGet},
		{"dodge", lcuDodgeHandler, http.MethodGet},
		{"presence", lcuAvailabilityHandler, http.MethodGet},
		{"profile background", lcuProfileBackgroundHandler, http.MethodGet},
		{"profile icon", lcuProfileIconHandler, http.MethodGet},
		{"honor ballot", lcuHonorBallotHandler, http.MethodPost},
		{"honor player", lcuHonorPlayerHandler, http.MethodGet},
		{"play again", lcuPlayAgainHandler, http.MethodGet},
		{"claim rewards", lcuClaimEventRewardsHandler, http.MethodGet},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			test.handler(recorder, httptest.NewRequest(test.method, "/api/test", nil))
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("wrong method returned %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
			}
		})
	}
}

func TestLCUAssetProxyRejectsNonAssetPaths(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/lol-game-data/../lol-summoner/v1/current-summoner", nil)
	lcuAssetProxyHandler(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unsafe asset path returned %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestQoLQueuePresetHandlerRejectsInvalidPolicyBeforePersistence(t *testing.T) {
	previous := qolManager
	t.Cleanup(func() { qolManager = previous })
	manager, err := qol.NewManager(filepath.Join(t.TempDir(), "qol.json"))
	if err != nil {
		t.Fatal(err)
	}
	qolManager = manager
	for _, payload := range []string{
		`{"queue":"not-a-queue","preset":{"first":"TOP","second":"FILL"}}`,
		`{"queue":"ranked_solo","preset":{"first":"TOP","second":"TOP"}}`,
	} {
		recorder := httptest.NewRecorder()
		qolQueuePresetsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/qol/queue-presets", bytes.NewBufferString(payload)))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("invalid queue preset returned %d: %s", recorder.Code, recorder.Body.String())
		}
	}
	if manager.Preferences().RolePresets != nil {
		t.Fatalf("invalid queue presets were persisted: %#v", manager.Preferences().RolePresets)
	}
}
