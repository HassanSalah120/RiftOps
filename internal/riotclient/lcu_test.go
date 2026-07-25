package riotclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testLockfile(serverURL string) *Lockfile {
	return &Lockfile{BaseURL: serverURL, Password: "test-password"}
}

func TestSetStatusMessageEncodesJSONAndChecksResponse(t *testing.T) {
	var received struct {
		StatusMessage string `json:"statusMessage"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/lol-chat/v1/me" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if got, want := r.Header.Get("Authorization"), "Basic cmlvdDp0ZXN0LXBhc3N3b3Jk"; got != want {
			t.Fatalf("authorization = %q, want %q", got, want)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode JSON: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	message := "Ready\nfor \"ranked\""
	if err := testLockfile(server.URL).SetStatusMessage(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	if received.StatusMessage != message {
		t.Fatalf("status message = %q, want %q", received.StatusMessage, message)
	}
}

func TestLCUActionReturnsErrorOnNonSuccessStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte("not in champion select"))
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).DoDodge(context.Background()); err == nil {
		t.Fatal("DoDodge succeeded for an LCU error response")
	}
}

func TestSetProfileBackgroundUsesLCUProfilePayload(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/lol-summoner/v1/current-summoner/summoner-profile" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode JSON: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).SetProfileBackground(context.Background(), 147002); err != nil {
		t.Fatal(err)
	}
	if received["key"] != "backgroundSkinId" || received["value"] != float64(147002) {
		t.Fatalf("background payload = %#v", received)
	}
}

func TestDodgeUsesGameflowEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/lol-gameflow/v1/session/dodge" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).DoDodge(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestLockfileRespondsRequiresLiveGameflowEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/lol-gameflow/v1/gameflow-phase" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`"Lobby"`))
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if !lockfileResponds(testLockfile(server.URL)) {
		t.Fatal("expected live LCU endpoint to be accepted")
	}
}

func TestSetRolesUsesCurrentLobbyRoute(t *testing.T) {
	var received map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/lol-lobby/v1/lobby/members/localMember/position-preferences" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode JSON: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).AutoSetRoles(context.Background(), "MIDDLE", "TOP"); err != nil {
		t.Fatal(err)
	}
	if received["firstPreference"] != "MIDDLE" || received["secondPreference"] != "TOP" {
		t.Fatalf("roles payload = %#v", received)
	}
}

func TestClaimMissionsPostsEachCompletedMission(t *testing.T) {
	var claims []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-missions/v1/missions":
			_, _ = w.Write([]byte(`[{"id":"complete-1","status":"COMPLETED"},{"id":"progress-1","status":"IN_PROGRESS"},{"id":"complete 2","status":"completed"}]`))
		case r.Method == http.MethodPost:
			claims = append(claims, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request = %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	claimed, err := testLockfile(server.URL).ClaimMissions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if claimed != 2 {
		t.Fatalf("claimed = %d, want 2", claimed)
	}
	if got, want := strings.Join(claims, ","), "/lol-missions/v1/missions/complete-1,/lol-missions/v1/missions/complete 2"; got != want {
		t.Fatalf("claim paths = %q, want %q", got, want)
	}
}
