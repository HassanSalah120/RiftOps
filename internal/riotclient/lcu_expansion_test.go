package riotclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExpansionChampionSwapContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-champ-select/v1/session/champion-swaps":
			_, _ = w.Write([]byte(`[{"id":17,"cellId":3,"state":"AVAILABLE"}]`))
		case r.Method == http.MethodPost && r.URL.Path == "/lol-champ-select/v1/session/champion-swaps/17/request":
			if r.ContentLength != 0 {
				t.Fatalf("request body length = %d, want zero", r.ContentLength)
			}
			_, _ = w.Write([]byte(`{"id":17,"cellId":3,"state":"SENT"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	lf := testLockfile(server.URL)
	swaps, err := lf.FetchChampSelectChampionSwaps(context.Background())
	if err != nil || len(swaps) != 1 || swaps[0].ID != 17 {
		t.Fatalf("swaps = %+v, err = %v", swaps, err)
	}
	updated, err := lf.UpdateChampSelectChampionSwap(context.Background(), 17, "request")
	if err != nil || updated.State != "SENT" {
		t.Fatalf("updated = %+v, err = %v", updated, err)
	}
}

func TestExpansionRewardBulkContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/lol-rewards/v1/select-bulk" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		var body []LCURewardSelection
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if len(body) != 1 || body[0].GrantID != "grant-1" || len(body[0].Selections) != 1 {
			t.Fatalf("body = %+v", body)
		}
		_, _ = w.Write([]byte(`{"grant-1":"SELECTED"}`))
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	result, err := testLockfile(server.URL).SelectRewardsBulk(context.Background(), []LCURewardSelection{{GrantID: "grant-1", RewardGroupID: "group-1", Selections: []string{"reward-1"}}})
	if err != nil || result["grant-1"] != "SELECTED" {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
}

func TestExpansionChatMutesDecodeMapAndStripSensitiveShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/lol-chat/v1/player-mutes" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"puuid-1":{"puuid":"puuid-1","isPlayerMuted":true,"isSettingsMuted":false,"isSystemMuted":true}}`))
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	mutes, err := testLockfile(server.URL).FetchChatMutes(context.Background())
	if err != nil || len(mutes) != 1 || !mutes[0].PlayerMuted || !mutes[0].SystemMuted {
		t.Fatalf("mutes = %+v, err = %v", mutes, err)
	}
}
