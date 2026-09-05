//go:build desktop

package main

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

func TestNormalizeReplayMetadataStatesAndProgress(t *testing.T) {
	tests := []struct {
		state    string
		progress float64
		want     string
		wantPct  float64
		ok       bool
	}{
		{"watch", 1, "ready", 0, true},
		{"downloading", .42, "downloading", 42, true},
		{"downloading", 64, "downloading", 64, true},
		{"found", 0, "available", 0, true},
		{"incompatible", 0, "expired", 0, true},
		{"new-state", 0, "failed", 0, false},
	}
	for _, test := range tests {
		t.Run(test.state, func(t *testing.T) {
			body := []byte(fmt.Sprintf(`{"gameId":77,"state":%q,"downloadProgress":%v}`, test.state, test.progress))
			got, ok := normalizeReplayMetadata("77", body)
			if ok != test.ok || got.Status != test.want || got.Progress != test.wantPct || got.GameID != 77 {
				t.Fatalf("normalizeReplayMetadata = %+v, %v; want status=%s progress=%v ok=%v", got, ok, test.want, test.wantPct, test.ok)
			}
		})
	}
	if got, ok := normalizeReplayMetadata("77", []byte(`not-json`)); ok || got.Status != "failed" {
		t.Fatalf("malformed replay metadata did not fail closed: %+v, %v", got, ok)
	}
}

func TestPresetPreviewGrantIsScopedExpiringAndSingleUse(t *testing.T) {
	presetPreviewGrants.Lock()
	presetPreviewGrants.items = make(map[string]presetPreviewGrant)
	presetPreviewGrants.Unlock()
	grant := newPresetPreview("profile", "preset-1", "account-1")
	if consumePresetPreview(grant.ID, "lobby", "preset-1", "account-1") {
		t.Fatal("preview grant escaped its feature scope")
	}
	if !consumePresetPreview(grant.ID, "profile", "preset-1", "account-1") {
		t.Fatal("valid preview grant was rejected")
	}
	if consumePresetPreview(grant.ID, "profile", "preset-1", "account-1") {
		t.Fatal("preview grant was reusable")
	}
	expired := newPresetPreview("profile", "preset-2", "account-1")
	presetPreviewGrants.Lock()
	value := presetPreviewGrants.items[expired.ID]
	value.ExpiresAt = time.Now().Add(-time.Second)
	presetPreviewGrants.items[expired.ID] = value
	presetPreviewGrants.Unlock()
	if consumePresetPreview(expired.ID, "profile", "preset-2", "account-1") {
		t.Fatal("expired preview grant was accepted")
	}
}

func TestProfileInventoryKeepsOnlyOwnedChoices(t *testing.T) {
	choices := collectInventoryChoices([]byte(`{"ranked":{"items":[{"id":"1","localizedName":"Owned","isOwned":true},{"id":"2","localizedName":"Locked","isOwned":false}]}}`))
	if !hasChoice(choices, "1") || hasChoice(choices, "2") {
		t.Fatalf("ownership catalogue = %+v", choices)
	}
	choices = collectInventoryChoices([]byte(`{"locked":{"isOwned":false,"items":[{"id":"3","isOwned":true}]}}`))
	if hasChoice(choices, "3") {
		t.Fatal("nested ownership escaped an unowned envelope")
	}
}

func TestMutationAmbiguityStopsOnlyUncertainFailures(t *testing.T) {
	if mutationResultAmbiguous(nil) || mutationResultAmbiguous(&riotclient.LCUError{StatusCode: http.StatusBadRequest}) {
		t.Fatal("ordinary validation failure was classified as ambiguous")
	}
	if !mutationResultAmbiguous(&riotclient.LCUError{StatusCode: http.StatusInternalServerError}) || !mutationResultAmbiguous(fmt.Errorf("transport failed")) {
		t.Fatal("uncertain mutation failure was not classified as ambiguous")
	}
}

func TestSummarizeFieldResultsReportsPartialFailures(t *testing.T) {
	if ok, partial := summarizeFieldResults(map[string]string{"icon": "applied", "title": "skipped: not owned"}); ok || !partial {
		t.Fatalf("mixed field results = ok=%v partial=%v; want ok=false partial=true", ok, partial)
	}
	if ok, partial := summarizeFieldResults(map[string]string{"icon": "applied", "background": "applied"}); !ok || partial {
		t.Fatalf("successful field results = ok=%v partial=%v; want ok=true partial=false", ok, partial)
	}
	if ok, partial := summarizeFieldResults(map[string]string{"spells": "waiting for champion select"}); ok || partial {
		t.Fatalf("deferred field result = ok=%v partial=%v; want ok=false partial=false", ok, partial)
	}
}

func TestNormalizeGameVersionLabelKeepsUnknownShapesHonest(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "string", body: `"15.18.1"`, want: "15.18.1"},
		{name: "object", body: `{"gameVersion":"15.18.1"}`, want: "15.18.1"},
		{name: "patchline alias", body: `{"patchline":"live"}`, want: "live"},
		{name: "unknown object", body: `{"unexpected":true}`, want: "unknown"},
		{name: "malformed", body: `not-json`, want: "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizeGameVersionLabel([]byte(test.body)); got != test.want {
				t.Fatalf("normalizeGameVersionLabel(%s) = %q, want %q", test.body, got, test.want)
			}
		})
	}
}

func TestSocialPayloadShapeRejectsScalarsAndMalformedJSON(t *testing.T) {
	for _, body := range []string{"[]", "{}"} {
		if !isJSONObjectOrArray([]byte(body)) {
			t.Fatalf("expected %s to be accepted as a collection", body)
		}
	}
	for _, body := range []string{"null", `"friends"`, "42", "not-json", ""} {
		if isJSONObjectOrArray([]byte(body)) {
			t.Fatalf("expected %q to be rejected as a collection", body)
		}
	}
}

func TestProfileIconMetadataRequiresArrayShape(t *testing.T) {
	if !isJSONArray([]byte(`[{"id":1}]`)) {
		t.Fatal("valid profile icon metadata array was rejected")
	}
	for _, body := range []string{`{"icons":[]}`, `null`, `"icons"`, "not-json"} {
		if isJSONArray([]byte(body)) {
			t.Fatalf("unexpected profile icon metadata shape accepted: %s", body)
		}
	}
}

func TestRewardSelectionMustBelongToCurrentGrantAndGroup(t *testing.T) {
	body := []byte(`[{"grantId":"grant-1","rewardGroups":[{"rewardGroupId":"group-a","rewards":[{"rewardId":"reward-1"},{"rewardId":"reward-2"}]},{"rewardGroupId":"group-b","rewards":[{"rewardId":"reward-3"}]}]}]`)
	if !rewardSelectionPresent(body, "grant-1", "group-a", []string{"reward-1", "reward-2"}) {
		t.Fatal("valid server-provided reward selection was rejected")
	}
	if rewardSelectionPresent(body, "grant-1", "group-a", []string{"reward-3"}) || rewardSelectionPresent(body, "grant-2", "group-a", []string{"reward-1"}) {
		t.Fatal("reward escaped its current grant/group boundary")
	}
	if !rewardSelectionPresent([]byte(`{"grants":[{"id":"grant-2","rewardGroups":[{"groupId":"group-z","rewards":[{"id":"reward-z"}]}]}]}`), "grant-2", "group-z", []string{"reward-z"}) {
		t.Fatal("grant id envelope was not recognized")
	}
}
