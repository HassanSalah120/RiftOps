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

func TestSetProfileIconUsesCurrentSummonerIconRoute(t *testing.T) {
	var received struct {
		ProfileIconID  int    `json:"profileIconId"`
		InventoryToken string `json:"inventoryToken"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/lol-lobby/v1/parties/player" {
			_, _ = w.Write([]byte(`{"registration":{"simpleInventoryToken":"test-inventory-token"}}`))
			return
		}
		if r.Method != http.MethodPut || r.URL.Path != "/lol-summoner/v1/current-summoner/icon" {
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

	if err := testLockfile(server.URL).SetProfileIcon(context.Background(), 1234); err != nil {
		t.Fatal(err)
	}
	if received.ProfileIconID != 1234 {
		t.Fatalf("profile icon payload = %#v, want 1234", received)
	}
	if received.InventoryToken != "test-inventory-token" {
		t.Fatalf("inventory token = %q, want active inventory token", received.InventoryToken)
	}
}

func TestSetProfileIconUsesInventoryTokenArray(t *testing.T) {
	var received struct {
		InventoryToken string `json:"inventoryToken"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/lol-lobby/v1/parties/player" {
			_, _ = w.Write([]byte(`{"registration":{"inventoryTokens":["array-inventory-token"]},"multiProductRegistration":{"inventoryTokens":["multi-inventory-token"]}}`))
			return
		}
		if r.Method != http.MethodPut || r.URL.Path != "/lol-summoner/v1/current-summoner/icon" {
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

	if err := testLockfile(server.URL).SetProfileIcon(context.Background(), 7188); err != nil {
		t.Fatal(err)
	}
	if received.InventoryToken != "array-inventory-token" {
		t.Fatalf("inventory token = %q, want array-inventory-token", received.InventoryToken)
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
	var received struct {
		PositionPreferences map[string]string `json:"positionPreferences"`
	}
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
	if received.PositionPreferences["firstPositionPreference"] != "MIDDLE" || received.PositionPreferences["secondPositionPreference"] != "TOP" {
		t.Fatalf("roles payload = %#v", received)
	}
}

func TestSetRolesFallsBackToV2LobbyRoute(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/lol-lobby/v1/lobby/members/localMember/position-preferences" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.Path != "/lol-lobby/v2/lobby/members/localMember/position-preferences" {
			t.Fatalf("unexpected fallback path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).AutoSetRoles(context.Background(), "JUNGLE", "MIDDLE"); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(paths, ","), "/lol-lobby/v1/lobby/members/localMember/position-preferences,/lol-lobby/v2/lobby/members/localMember/position-preferences"; got != want {
		t.Fatalf("paths = %q, want %q", got, want)
	}
}

func TestHonorPlayerUsesCurrentPayload(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/lol-honor-v2/v1/honor-player" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).HonorPlayer(context.Background(), 42, "player-puuid", "HEART", 9001); err != nil {
		t.Fatal(err)
	}
	if received["puuid"] != "player-puuid" || received["honorType"] != "HEART" ||
		received["summonerId"] != float64(42) || received["gameId"] != float64(9001) {
		t.Fatalf("honor payload = %#v", received)
	}
	if _, exists := received["honorCategory"]; exists {
		t.Fatalf("honor payload still contains obsolete honorCategory: %#v", received)
	}
}

func TestFetchQoLStateUsesLiveClientSurfaces(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lol-gameflow/v1/gameflow-phase":
			_, _ = w.Write([]byte(`"Lobby"`))
		case "/lol-chat/v1/me":
			_, _ = w.Write([]byte(`{"availability":"away","statusMessage":"ranked","icon":123}`))
		case "/lol-lobby/v2/lobby/matchmaking/search-state":
			_, _ = w.Write([]byte(`"Invalid"`))
		case "/lol-lobby/v2/lobby":
			_, _ = w.Write([]byte(`{"localMember":{"firstPositionPreference":"MIDDLE","secondPositionPreference":"TOP"}}`))
		case "/lol-summoner/v1/current-summoner/summoner-profile":
			_, _ = w.Write([]byte(`{"backgroundSkinId":147002}`))
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	state, err := testLockfile(server.URL).FetchQoLState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != "Lobby" || state.Availability != "away" || state.StatusMessage != "ranked" ||
		state.ProfileIconID != 123 || state.QueueState != "Invalid" ||
		state.FirstRole != "MIDDLE" || state.SecondRole != "TOP" || state.BackgroundSkin != 147002 {
		t.Fatalf("QoL state = %#v", state)
	}
}

func TestDecodeQueueStateSupportsObjectPayloads(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "search state", body: `{"searchState":"Searching"}`, want: "Searching"},
		{name: "queue state", body: `{"queueState":"Found"}`, want: "Found"},
		{name: "legacy string", body: `"Invalid"`, want: "Invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := decodeQueueState([]byte(test.body)); got != test.want {
				t.Fatalf("decodeQueueState(%s) = %q, want %q", test.body, got, test.want)
			}
		})
	}
}

func TestClaimEventRewardsOnlyClaimsAvailableRewards(t *testing.T) {
	var claims []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-event-hub/v1/events":
			_, _ = w.Write([]byte(`[{"eventId":"event-1"},{"eventId":"event 2"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/lol-event-hub/v1/events/event-1/reward-track/unclaimed-rewards":
			_, _ = w.Write([]byte(`{"rewardsCount":2}`))
		case r.Method == http.MethodGet && r.URL.Path == "/lol-event-hub/v1/events/event 2/reward-track/unclaimed-rewards":
			_, _ = w.Write([]byte(`{"rewardsCount":0}`))
		case r.Method == http.MethodPost && r.URL.Path == "/lol-event-hub/v1/events/event-1/reward-track/claim-all":
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

	claimed, err := testLockfile(server.URL).ClaimEventRewards(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if claimed != 2 {
		t.Fatalf("claimed rewards = %d, want 2", claimed)
	}
	if got, want := strings.Join(claims, ","), "/lol-event-hub/v1/events/event-1/reward-track/claim-all"; got != want {
		t.Fatalf("claim paths = %q, want %q", got, want)
	}
}
