package riotclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGameClientFetchActiveGameNormalizesAllGameData(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/liveclientdata/allgamedata" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
  "activePlayer": {"summonerName":"RiftOps","championName":"Ahri","level":12,"currentGold":845,"championStats":{"attackDamage":93}},
  "allPlayers": [{"summonerName":"RiftOps","championName":"Ahri","team":"ORDER","position":"MIDDLE","level":12,"scores":{"kills":4,"deaths":1,"assists":7,"creepScore":112},"items":[{"itemID":3089,"count":1,"displayName":"Rabadon's Deathcap"}]}],
  "events": {"Events": [{"EventID":3,"EventName":"DragonKill","EventTime":421.5}]},
  "arena": {"round": 2, "fame": 42},
  "gameData": {"gameId":123,"gameTime":421.5,"queueId":420,"gameMode":"CLASSIC","mapName":"Summoner's Rift","mapNumber":11,"mode":"MOBA","platformId":"EUW1"}
}`))
	}))
	defer server.Close()

	client := NewGameClient(server.URL, server.Client())
	data, err := client.FetchActiveGame(context.Background())
	if err != nil {
		t.Fatalf("FetchActiveGame() error = %v", err)
	}
	if !data.Available || data.GameData.GameID != "123" || data.GameData.QueueID != 420 || data.GameData.MapNumber != 11 {
		t.Fatalf("unexpected game data: %+v", data)
	}
	if data.ActivePlayer == nil || data.ActivePlayer.ChampionName != "Ahri" || data.ActivePlayer.CurrentGold != 845 {
		t.Fatalf("unexpected active player: %+v", data.ActivePlayer)
	}
	if len(data.Players) != 1 || data.Players[0].Scores.CreepScore != 112 || len(data.Players[0].Items) != 1 {
		t.Fatalf("unexpected players: %+v", data.Players)
	}
	if len(data.Events) != 1 || data.Events[0].EventName != "DragonKill" {
		t.Fatalf("unexpected events: %+v", data.Events)
	}
	if data.Arena["round"] != float64(2) || data.Arena["fame"] != float64(42) {
		t.Fatalf("unexpected arena data: %+v", data.Arena)
	}
}

func TestGameClientFetchActiveGameRejectsNonSuccess(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not in a game", 404)
	}))
	defer server.Close()

	client := NewGameClient(server.URL, server.Client())
	if _, err := client.FetchActiveGame(context.Background()); err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("expected HTTP error, got %v", err)
	}
}

func TestDefaultGameClientUsesLoopbackTLS(t *testing.T) {
	if defaultGameClient.BaseURL != gameClientDefaultURL {
		t.Fatalf("default BaseURL = %q", defaultGameClient.BaseURL)
	}
	transport, ok := defaultGameClient.HTTPClient.Transport.(*http.Transport)
	if !ok || transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("default game client must trust the local self-signed certificate")
	}
}
