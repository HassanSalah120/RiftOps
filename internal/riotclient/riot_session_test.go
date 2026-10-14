package riotclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQuitRequestsGracefulExitWithoutSigningOut(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/process-control/v1/process/quit" {
			t.Errorf("unexpected shutdown: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	lf := testLockfile(server.URL)
	lf.Source = "riot-client"
	if err := lf.Quit(context.Background()); err != nil {
		t.Fatal(err)
	}
	lf.Source = "league"
	if err := lf.Quit(context.Background()); err == nil {
		t.Fatal("accepted a League lockfile for Riot shutdown")
	}
	if requests != 1 {
		t.Fatal("made extra shutdown requests")
	}
}

func TestFetchRiotAccountSessionReturnsOnlyAuthorizedIdentity(t *testing.T) {
	const secret = "secret-must-not-leak"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/player-session-lifecycle/v1/session" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"loginState":"Authorized","puuid":"puuid-one","riotID":{"gameName":"Player","tagLine":"NA1"},"userInfoToken":"` + secret + `"}`))
	}))
	defer server.Close()
	lockfile := testLockfile(server.URL)
	lockfile.Source = "riot-client"
	account, err := lockfile.FetchRiotAccountSession(context.Background())
	if err != nil || !account.Authorized || account.PUUID != "puuid-one" || account.RiotID != "Player#NA1" {
		t.Fatalf("unexpected sanitized account: %+v, %v", account, err)
	}
	if strings.Contains(strings.Join([]string{account.PUUID, account.RiotID}, ""), secret) {
		t.Fatal("auth material was returned")
	}
}

func TestFetchRiotAccountSessionFailsClosed(t *testing.T) {
	for _, test := range []struct {
		name      string
		body      string
		status    int
		wantError bool
	}{
		{"logged out", `{"loginState":"SignedOut","puuid":"puuid-one"}`, http.StatusOK, false},
		{"missing identity", `{"loginState":"Authorized","puuid":"puuid-one"}`, http.StatusOK, true},
		{"malformed", `{`, http.StatusOK, true},
		{"upstream failure", `{"userInfoToken":"secret-must-not-leak"}`, http.StatusInternalServerError, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			lockfile := testLockfile(server.URL)
			lockfile.Source = "riot-client"
			account, err := lockfile.FetchRiotAccountSession(context.Background())
			if (err != nil) != test.wantError || account.Authorized {
				t.Fatalf("authorized=%v error=%v, wantError=%v", account.Authorized, err, test.wantError)
			}
			if err != nil && strings.Contains(err.Error(), "secret-must-not-leak") {
				t.Fatal("upstream auth material leaked in error")
			}
		})
	}
}

func TestPendingProductContextRequiresAuthenticatedRSOAndStableIdentity(t *testing.T) {
	for _, test := range []struct {
		name, rso      string
		status         int
		changed        bool
		wantAuthorized bool
	}{
		{"signed in", `{"type":"authenticated"}`, http.StatusOK, false, true},
		{"MFA pending", `{"type":"needs_multifactor_verification"}`, http.StatusOK, false, false},
		{"signed out", `{"type":"needs_credentials"}`, http.StatusOK, false, false},
		{"RSO booting", `{"message":"RSO is not yet initialized"}`, http.StatusNotFound, false, false},
		{"invalid response", `{`, http.StatusOK, false, false},
		{"account changed", `{"type":"authenticated"}`, http.StatusOK, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			reads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("unexpected mutation: %s", r.Method)
				}
				switch r.URL.Path {
				case "/player-session-lifecycle/v1/session":
					reads++
					puuid := "synthetic-one"
					if test.changed && reads > 1 {
						puuid = "synthetic-two"
					}
					_, _ = w.Write([]byte(`{"loginState":"PendingProductContext","puuid":"` + puuid + `","riotID":{"gameName":"Synthetic","tagLine":"TEST"}}`))
				case "/rso-auth/v1/session":
					w.WriteHeader(test.status)
					_, _ = w.Write([]byte(test.rso))
				default:
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
			}))
			defer server.Close()
			lf := testLockfile(server.URL)
			lf.Source = "riot-client"
			account, _ := lf.FetchRiotAccountSession(context.Background())
			if account.Authorized != test.wantAuthorized {
				t.Fatalf("authorized=%v, want %v", account.Authorized, test.wantAuthorized)
			}
		})
	}
}

func TestFetchConnectedLeagueAccountDetectsCurrentServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lol-summoner/v1/current-summoner":
			_, _ = w.Write([]byte(`{"puuid":"player-one","gameName":"Player","tagLine":"NA1"}`))
		case "/riotclient/region-locale":
			_, _ = w.Write([]byte(`{"region":"EUW","locale":"en_US"}`))
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	lockfile := testLockfile(server.URL)
	lockfile.Source = "league"
	account, err := lockfile.FetchConnectedLeagueAccount(context.Background())
	if err != nil || account.PUUID != "player-one" || account.RiotID != "Player#NA1" || account.Region != "EUW1" {
		t.Fatalf("detected account = %+v, error = %v", account, err)
	}
}

func TestFetchConnectedLeagueAccountUsesPUUIDWhenLeagueOmitsRiotID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lol-summoner/v1/current-summoner":
			_, _ = w.Write([]byte(`{"puuid":"player-one"}`))
		case "/riotclient/region-locale":
			_, _ = w.Write([]byte(`{"region":"NA"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	lockfile := testLockfile(server.URL)
	lockfile.Source = "league"
	account, err := lockfile.FetchConnectedLeagueAccount(context.Background())
	if err != nil || account.PUUID != "player-one" || account.Region != "NA1" {
		t.Fatalf("detected account = %+v, error = %v", account, err)
	}
}

func TestLeagueRegionNormalizationNeverGuessesUnknownServer(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"EUW", "EUW1"}, {"EUNE", "EUN1"}, {"LAN", "LA1"}, {"LAS", "LA2"},
		{"OCE", "OC1"}, {"PH", "PH2"}, {"KR", "KR"}, {"EUW1", "EUW1"},
		{"UNKNOWN", ""}, {"", ""},
	} {
		if got := NormalizeLeagueRegion(test.input); got != test.want {
			t.Errorf("NormalizeLeagueRegion(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}
