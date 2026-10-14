//go:build desktop

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/featurestore"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

func TestAccountRanksStayBoundToAccountAndServerAndSurviveOffline(t *testing.T) {
	for _, mode := range []string{"success", "different Riot account", "switch during fetch", "rank unavailable", "missing ranked data", "unranked"} {
		t.Run(mode, func(t *testing.T) {
			store, err := featurestore.New(filepath.Join(t.TempDir(), "features.json"))
			if err != nil {
				t.Fatal(err)
			}
			key := featurestore.RankKey("Synthetic#TEST", "EUW1")
			old := queueRanks([]riotclient.LCULeagueEntry{{QueueType: "RANKED_SOLO_5x5", Tier: "SILVER", Rank: "III", LeaguePoints: 20}})
			if err := store.Update(func(d *featurestore.Data) error { d.AccountRanks[key] = old; return nil }); err != nil {
				t.Fatal(err)
			}
			fetched := false
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("unexpected mutation: %s", r.Method)
				}
				switch r.URL.Path {
				case "/lol-summoner/v1/current-summoner":
					puuid := "synthetic-one"
					if fetched && mode == "switch during fetch" {
						puuid = "synthetic-two"
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"puuid": puuid, "gameName": "Synthetic", "tagLine": "TEST"})
				case "/riotclient/region-locale":
					_, _ = w.Write([]byte(`{"region":"EUW"}`))
				case "/lol-ranked/v1/current-ranked-stats":
					fetched = true
					if mode == "rank unavailable" {
						http.Error(w, "unavailable", http.StatusServiceUnavailable)
						return
					}
					if mode == "unranked" {
						_, _ = w.Write([]byte(`{"queues":[]}`))
						return
					}
					if mode == "missing ranked data" {
						_, _ = w.Write([]byte(`{}`))
						return
					}
					_, _ = w.Write([]byte(`{"queues":[{"queueType":"RANKED_SOLO_5x5","tier":"DIAMOND","division":"II","leaguePoints":64},{"queueType":"RANKED_FLEX_SR","tier":"GOLD","rank":"IV","leaguePoints":12}]}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			lf := &riotclient.Lockfile{BaseURL: server.URL, Source: "league", Password: "synthetic-password"}
			readRiot := func(context.Context) (riotclient.RiotAccountSession, error) {
				puuid := "synthetic-one"
				if mode == "different Riot account" {
					puuid = "synthetic-other"
				}
				return riotclient.RiotAccountSession{PUUID: puuid, RiotID: "Synthetic#TEST", Authorized: true}, nil
			}
			refreshAccountRank(context.Background(), lf, store, readRiot)
			// Reopen the persisted store with no client to model restarting RiftOps offline.
			reloaded, err := featurestore.New(store.Path)
			if err != nil {
				t.Fatal(err)
			}
			profiles := []settings.LaunchProfile{
				{ID: "right", RiotID: "Synthetic#TEST", Region: "EUW1"},
				{ID: "wrong-server", RiotID: "Synthetic#TEST", Region: "EUN1"},
				{ID: "wrong-account", RiotID: "Other#TEST", Region: "EUW1"},
			}
			result := profilesWithRanks(profiles, reloaded.Snapshot().AccountRanks)
			if result[1].Rank != nil || result[2].Rank != nil {
				t.Fatal("rank leaked into a different account/server")
			}
			if result[0].Rank == nil {
				t.Fatal("offline rank was lost")
			}
			want := "SILVER"
			if mode == "success" {
				want = "DIAMOND"
			}
			if mode == "unranked" {
				want = "UNRANKED"
			}
			if result[0].Rank.Solo.Tier != want {
				t.Fatalf("rank=%s, want %s", result[0].Rank.Solo.Tier, want)
			}
			if mode == "success" && (result[0].Rank.Solo.Division != "II" || result[0].Rank.Solo.LeaguePoints != 64 || result[0].Rank.Flex.Tier != "GOLD") {
				t.Fatal("queue or LP data was lost")
			}
		})
	}
}
