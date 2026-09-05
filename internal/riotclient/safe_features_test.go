package riotclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSafeFeatureAdaptersUseFixedRoutesAndPayloads(t *testing.T) {
	seen := make([]string, 0, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/lol-lobby/v2/lobby/invitations" {
			var payload []map[string]int64
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload) != 1 || payload[0]["toSummonerId"] != 77 {
				t.Fatalf("invite payload = %+v, err=%v", payload, err)
			}
		}
		if r.URL.Path == "/lol-challenges/v1/update-player-preferences" {
			var payload struct {
				Title        string `json:"title"`
				ChallengeIDs []int  `json:"challengeIds"`
				BannerAccent string `json:"bannerAccent"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Title != "10" || len(payload.ChallengeIDs) != 2 || payload.BannerAccent != "ranked" {
				t.Fatalf("challenge payload = %+v, err=%v", payload, err)
			}
		}
		if r.URL.Path == "/lol-regalia/v2/current-summoner/regalia" {
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["preferredBannerType"] != "ranked" || payload["preferredCrestType"] != "prestige" || payload["selectedPrestigeCrest"] != float64(3) {
				t.Fatalf("regalia payload = %+v, err=%v", payload, err)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()
	lf := testLockfile(server.URL)
	ctx := context.Background()
	if err := lf.InviteFriends(ctx, []string{"77"}); err != nil {
		t.Fatal(err)
	}
	if err := lf.UpdateFriendRequest(ctx, "12", "both"); err != nil {
		t.Fatal(err)
	}
	if err := lf.DeleteFriendRequest(ctx, "12"); err != nil {
		t.Fatal(err)
	}
	if err := lf.RemoveFriend(ctx, "13"); err != nil {
		t.Fatal(err)
	}
	if err := lf.AddCustomBot(ctx, 1, "hard", "200"); err != nil {
		t.Fatal(err)
	}
	if err := lf.DownloadReplay(ctx, "123"); err != nil {
		t.Fatal(err)
	}
	if err := lf.UpdateChallengePreferences(ctx, "10", []int{20, 30}, "ranked"); err != nil {
		t.Fatal(err)
	}
	if err := lf.UpdateProfileRegalia(ctx, "ranked", "prestige", 3); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"POST /lol-lobby/v2/lobby/invitations",
		"PUT /lol-chat/v1/friend-requests/12",
		"DELETE /lol-chat/v1/friend-requests/12",
		"DELETE /lol-chat/v1/friends/13",
		"POST /lol-lobby/v1/lobby/custom/bots",
		"POST /lol-replays/v1/rofls/123/download",
		"POST /lol-challenges/v1/update-player-preferences",
		"PUT /lol-regalia/v2/current-summoner/regalia",
	}
	if strings.Join(seen, "|") != strings.Join(want, "|") {
		t.Fatalf("routes = %v, want %v", seen, want)
	}
}

func TestSafeFeatureAdaptersRejectUnsafeInputs(t *testing.T) {
	lf := testLockfile("http://127.0.0.1:1")
	ctx := context.Background()
	checks := []struct {
		name string
		run  func() error
	}{
		{"invite limit", func() error { return lf.InviteFriends(ctx, make([]string, 21)) }},
		{"invite id", func() error { return lf.InviteFriends(ctx, []string{"0"}) }},
		{"bot champion", func() error { return lf.AddCustomBot(ctx, 0, "easy", "100") }},
		{"bot difficulty", func() error { return lf.AddCustomBot(ctx, 1, "instant", "100") }},
		{"bot team", func() error { return lf.AddCustomBot(ctx, 1, "easy", "red") }},
		{"replay id", func() error { return lf.DownloadReplay(ctx, "-1") }},
		{"settings json", func() error { return lf.PatchGameSettings(ctx, []byte("not json")) }},
		{"too many challenge tokens", func() error { return lf.UpdateChallengePreferences(ctx, "", []int{1, 2, 3, 4}, "") }},
		{"invalid regalia", func() error { return lf.UpdateProfileRegalia(ctx, "", "prestige", 1) }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.run(); err == nil {
				t.Fatal("expected input validation error")
			}
		})
	}
}
