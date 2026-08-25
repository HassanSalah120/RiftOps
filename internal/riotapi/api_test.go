package riotapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRiotAPIKeyUsesOfficialHeader(t *testing.T) {
	t.Setenv("RIOT_API_KEY", "test-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Riot-Token"); got != "test-key" {
			t.Fatalf("X-Riot-Token = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Fatalf("unexpected bearer header = %q", got)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	previousClient := client
	client = server.Client()
	defer func() { client = previousClient }()

	body, err := doRequest(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"ok":true}` {
		t.Fatalf("body = %s", body)
	}
	if AuthSource() != "api-key" || IsUsingLCU() {
		t.Fatalf("auth source = %q, using LCU = %v", AuthSource(), IsUsingLCU())
	}
}

func TestMatchV5EndpointUsesRegionRoutingAndEscapesPath(t *testing.T) {
	got := matchV5Endpoint("EUW", "matches/by-puuid/player/id/ids?start=0&count=20")
	if got != "https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/player/id/ids?start=0&count=20" {
		t.Fatalf("endpoint = %q", got)
	}
	if got := matchV5Endpoint("unknown", "/matches/abc"); got != "https://americas.api.riotgames.com/lol/match/v5/matches/abc" {
		t.Fatalf("unknown-region endpoint = %q", got)
	}
}
