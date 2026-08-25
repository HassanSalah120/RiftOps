package riotclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func testLockfile(serverURL string) *Lockfile {
	return &Lockfile{BaseURL: serverURL, Password: "test-password", allowInsecure: true}
}

func TestParseLockfileValidatesFieldsAndPreservesPasswordColons(t *testing.T) {
	lockfile, err := parseLockfile("LeagueClient:42:12345:secret:with-colon:https")
	if err != nil {
		t.Fatal(err)
	}
	if lockfile.PID != 42 || lockfile.Port != 12345 || lockfile.Password != "secret:with-colon" || lockfile.Protocol != "https" {
		t.Fatalf("lockfile = %+v", lockfile)
	}
	for _, input := range []string{
		"LeagueClient:not-a-pid:12345:secret:https",
		"LeagueClient:42:0:secret:https",
		"LeagueClient:42:12345:secret:http",
		"LeagueClient:42:12345::https",
	} {
		if _, err := parseLockfile(input); err == nil {
			t.Fatalf("malformed lockfile was accepted: %q", input)
		}
	}
}

func TestProcessCredentialsStayPaired(t *testing.T) {
	processes := parseProcessSnapshots([]byte(`[{"Name":"RiotClientServices.exe","ProcessId":11,"CommandLine":"RiotClientServices.exe --app-port=1111 --remoting-auth-token=riot-token"},{"Name":"LeagueClientUx.exe","ProcessId":22,"CommandLine":"LeagueClientUx.exe --app-port=2222 --remoting-auth-token=league-token"}]`))
	if len(processes) != 2 {
		t.Fatalf("processes = %+v", processes)
	}
	lf, ok := lockfileFromProcess(processes[1])
	if !ok || lf.Source != "league" || lf.Port != 2222 || lf.Password != "league-token" || lf.PID != 22 {
		t.Fatalf("league credentials were not paired: %+v, ok=%v", lf, ok)
	}
}

func TestLeagueLockfileCandidatesIncludeDirectInstallFolder(t *testing.T) {
	base := filepath.Join(t.TempDir(), "League of Legends")
	paths := leagueLockfileCandidates([]string{base})
	want := filepath.Join(base, "lockfile")
	for _, path := range paths {
		if path == want {
			return
		}
	}
	t.Fatalf("league lockfile candidates %v do not include direct install path %q", paths, want)
}

func TestInstallBasesFromMetadataWalksNestedPaths(t *testing.T) {
	leagueDir := filepath.Join(t.TempDir(), "League of Legends")
	data := []byte(`{"associated_client":{"` + filepath.ToSlash(leagueDir) + `/":"C:/Riot Games/Riot Client/RiotClientServices.exe"}}`)
	bases := installBasesFromMetadata(data)
	if !containsPath(bases, leagueDir) {
		t.Fatalf("bases = %v, want executable directory %q", bases, leagueDir)
	}
	if !containsPath(bases, filepath.Dir(leagueDir)) {
		t.Fatalf("bases = %v, want parent directory %q", bases, filepath.Dir(leagueDir))
	}
}

func containsPath(paths []string, want string) bool {
	for _, path := range paths {
		if path == want {
			return true
		}
	}
	return false
}

func TestLobbyCreationDoesNotDeleteOnInvalidBadRequest(t *testing.T) {
	deletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes++
			t.Fatal("invalid lobby request deleted the current lobby")
		}
		if r.Method != http.MethodPost || r.URL.Path != "/lol-lobby/v2/lobby" {
			t.Fatalf("unexpected request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"errorCode":"INVALID_URI_FORMAT","message":"invalid custom lobby configuration"}`))
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	err := testLockfile(server.URL).CreateQueueLobby(context.Background(), 420)
	if err == nil || !strings.Contains(err.Error(), "invalid custom lobby configuration") {
		t.Fatalf("error = %v", err)
	}
	if deletes != 0 {
		t.Fatalf("delete count = %d, want 0", deletes)
	}
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

func TestChampSelectSwapActionUsesValidatedLCURoute(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/lol-champ-select/v1/session/position-swaps/12/accept" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).UpdateChampSelectSwap(context.Background(), "position", "accept", 12); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		kind, action string
		id           int
	}{
		{kind: "unknown", action: "request", id: 1},
		{kind: "position", action: "unknown", id: 1},
		{kind: "position", action: "request", id: -1},
	} {
		if err := testLockfile(server.URL).UpdateChampSelectSwap(context.Background(), test.kind, test.action, test.id); err == nil {
			t.Fatalf("invalid swap was accepted: %+v", test)
		}
	}
}

func TestLCUErrorBodyIsBoundedAndRedacted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("Authorization: Bearer secret-value pair=pair-secret "))
		_, _ = w.Write([]byte(strings.Repeat("x", maxLCUErrorBytes+1024)))
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	_, err := testLockfile(server.URL).DoRequest(context.Background(), http.MethodGet, "/test?access_token=query-secret")
	if err == nil {
		t.Fatal("oversized LCU error response succeeded")
	}
	message := err.Error()
	for _, secret := range []string{"secret-value", "pair-secret", "query-secret"} {
		if strings.Contains(message, secret) {
			t.Fatalf("LCU error leaked %q: %s", secret, message)
		}
	}
	if !strings.Contains(message, "[truncated]") || !strings.Contains(message, "?[REDACTED]") {
		t.Fatalf("LCU error did not report safe truncation: %s", message)
	}
	if len(message) > maxLCUErrorBytes+512 {
		t.Fatalf("LCU error was not bounded: %d bytes", len(message))
	}
}

func TestLCURejectsNonLoopbackBaseURL(t *testing.T) {
	lf := &Lockfile{BaseURL: "https://example.com", Password: "secret"}
	if _, err := lf.DoRequest(context.Background(), http.MethodGet, "/lol-test/v1/state"); err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("non-loopback LCU base URL was accepted: %v", err)
	}
}

func TestLCURejectsPlainHTTPOutsideTests(t *testing.T) {
	lf := &Lockfile{BaseURL: "http://127.0.0.1:1234", Password: "secret"}
	if _, err := lf.DoRequest(context.Background(), http.MethodGet, "/lol-test/v1/state"); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("plain HTTP LCU URL was accepted: %v", err)
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

func TestStartCustomGameUsesStartChampSelectEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-lobby/v2/lobby":
			_, _ = w.Write([]byte(`{"canStartActivity":true,"gameConfig":{"isCustom":true,"queueId":3110,"gameMode":"CLASSIC"},"localMember":{"isLeader":true,"allowedStartActivity":true}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/lol-lobby/v1/lobby/custom/start-champ-select":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).StartCustomGame(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestStartCustomGameRejectsMatchmadeLobby(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/lol-lobby/v2/lobby" {
			t.Fatalf("unexpected mutation = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"canStartActivity":true,"gameConfig":{"isCustom":false,"queueId":440,"gameMode":"CLASSIC"},"localMember":{"isLeader":true,"allowedStartActivity":true}}`))
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	err := testLockfile(server.URL).StartCustomGame(context.Background())
	if err == nil || !strings.Contains(err.Error(), "matchmade lobby") {
		t.Fatalf("error = %v, want matchmade lobby explanation", err)
	}
}

func TestCreateCustomLobbyPreservesQueueMapAndRequiredConfiguration(t *testing.T) {
	var payload struct {
		QueueID         int  `json:"queueId"`
		IsCustom        bool `json:"isCustom"`
		CustomGameLobby struct {
			Configuration struct {
				GameMode       string         `json:"gameMode"`
				MapID          int            `json:"mapId"`
				Mutators       map[string]int `json:"mutators"`
				GameTypeConfig map[string]int `json:"gameTypeConfig"`
			} `json:"configuration"`
		} `json:"customGameLobby"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/lol-lobby/v2/lobby" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).CreateCustomLobby(context.Background(), 3260, "JADE", "Classic Rift", 453); err != nil {
		t.Fatal(err)
	}
	if payload.QueueID != 3260 || !payload.IsCustom || payload.CustomGameLobby.Configuration.GameMode != "JADE" || payload.CustomGameLobby.Configuration.MapID != 453 {
		t.Fatalf("custom lobby identity was not preserved: %+v", payload)
	}
	if payload.CustomGameLobby.Configuration.Mutators["id"] != 1 || payload.CustomGameLobby.Configuration.GameTypeConfig["id"] != 1 {
		t.Fatalf("required custom configuration missing: %+v", payload.CustomGameLobby.Configuration)
	}
}

func TestQuitCustomSessionUsesCustomChampSelectRoute(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-lobby/v2/lobby":
			_, _ = w.Write([]byte(`{"isCustom":true,"gameConfig":{"queueId":3140}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/lol-lobby-team-builder/champ-select/v1/session/quit":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request = %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).QuitCustomSession(context.Background(), "ChampSelect"); err != nil {
		t.Fatal(err)
	}
}

func TestQuitCustomSessionUsesEarlyExitForPracticeGame(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-lobby/v2/lobby":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodGet && r.URL.Path == "/lol-gameflow/v1/session":
			_, _ = w.Write([]byte(`{"gameData":{"isCustom":true,"gameMode":"PRACTICETOOL"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/lol-gameflow/v1/early-exit":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request = %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).QuitCustomSession(context.Background(), "InProgress"); err != nil {
		t.Fatal(err)
	}
}

func TestChampSelectActionAndLoadoutUseLCURoutes(t *testing.T) {
	var actionPayload map[string]any
	var hoverPayload map[string]any
	var braveryPayload map[string]any
	var selectionPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPatch && r.URL.Path == "/lol-champ-select/v1/session/actions/42":
			if err := json.NewDecoder(r.Body).Decode(&actionPayload); err != nil {
				t.Fatalf("decode action: %v", err)
			}
		case r.Method == http.MethodPatch && r.URL.Path == "/lol-champ-select/v1/session/actions/0":
			if err := json.NewDecoder(r.Body).Decode(&hoverPayload); err != nil {
				t.Fatalf("decode hover: %v", err)
			}
		case r.Method == http.MethodPatch && r.URL.Path == "/lol-champ-select/v1/session/actions/2":
			if err := json.NewDecoder(r.Body).Decode(&braveryPayload); err != nil {
				t.Fatalf("decode bravery: %v", err)
			}
		case r.Method == http.MethodPatch && r.URL.Path == "/lol-champ-select/v1/session/my-selection":
			if err := json.NewDecoder(r.Body).Decode(&selectionPayload); err != nil {
				t.Fatalf("decode selection: %v", err)
			}
		default:
			t.Fatalf("unexpected request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	lf := testLockfile(server.URL)
	if err := lf.UpdateChampSelectAction(context.Background(), 42, 103, true); err != nil {
		t.Fatal(err)
	}
	if actionPayload["championId"] != float64(103) || actionPayload["completed"] != true {
		t.Fatalf("action payload = %#v", actionPayload)
	}
	if err := lf.UpdateChampSelectAction(context.Background(), 0, 103, false); err != nil {
		t.Fatalf("action id zero should be valid: %v", err)
	}
	if hoverPayload["championId"] != float64(103) {
		t.Fatalf("hover payload = %#v", hoverPayload)
	}
	if _, exists := hoverPayload["completed"]; exists {
		t.Fatalf("hover payload must leave completed unset: %#v", hoverPayload)
	}
	if err := lf.UpdateChampSelectAction(context.Background(), 2, ArenaBraveryChampionID, true); err != nil {
		t.Fatalf("Arena Bravery should be accepted: %v", err)
	}
	if braveryPayload["championId"] != float64(ArenaBraveryChampionID) || braveryPayload["completed"] != true {
		t.Fatalf("bravery payload = %#v", braveryPayload)
	}
	if err := lf.UpdateChampSelectSelection(context.Background(), 4, 14, 12345); err != nil {
		t.Fatal(err)
	}
	if selectionPayload["spell1Id"] != float64(4) || selectionPayload["spell2Id"] != float64(14) || selectionPayload["selectedSkinId"] != float64(12345) {
		t.Fatalf("selection payload = %#v", selectionPayload)
	}
}

func TestChampSelectCatalogueAndRuneRoutes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			switch r.URL.Path {
			case "/lol-champ-select/v1/pickable-champion-ids", "/lol-champ-select/v1/bannable-champion-ids", "/lol-perks/v1/pages", "/lol-perks/v1/perks":
				_, _ = w.Write([]byte(`[]`))
				return
			case "/lol-game-data/assets/v1/perkstyles.json":
				_, _ = w.Write([]byte(`{"styles":[]}`))
				return
			}
		}
		t.Fatalf("unexpected request = %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	lf := testLockfile(server.URL)
	if _, err := lf.FetchChampSelectPickable(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := lf.FetchChampSelectBannable(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := lf.FetchRunePages(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := lf.FetchRunePerks(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := lf.FetchRuneStyles(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRunePageMutationsUseCurrentLCURoutes(t *testing.T) {
	seen := make(map[string]map[string]any)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.Path
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			seen[key] = payload
		}
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":42}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	lf := testLockfile(server.URL)
	payload := map[string]any{"name": "Ahri", "primaryStyleId": 8100, "subStyleId": 8200, "selectedPerkIds": []int{8112, 8126, 8138, 8135, 8210, 8237, 5008, 5008, 5001}}
	if _, err := lf.CreateRunePage(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	if err := lf.UpdateRunePage(context.Background(), 42, payload); err != nil {
		t.Fatal(err)
	}
	if err := lf.DeleteRunePage(context.Background(), 42); err != nil {
		t.Fatal(err)
	}
	if _, ok := seen["POST /lol-perks/v1/pages"]; !ok {
		t.Fatal("create rune page route was not called")
	}
	if _, ok := seen["PUT /lol-perks/v1/pages/42"]; !ok {
		t.Fatal("update rune page route was not called")
	}
}

func TestChampSelectActionValidatesIDs(t *testing.T) {
	lf := testLockfile("http://127.0.0.1:1")
	if err := lf.UpdateChampSelectAction(context.Background(), -1, 103, false); err == nil {
		t.Fatal("expected action id validation error")
	}
	if err := lf.UpdateChampSelectAction(context.Background(), 1, 0, false); err == nil {
		t.Fatal("expected champion id validation error")
	}
	if err := lf.UpdateChampSelectAction(context.Background(), 1, -4, false); err == nil {
		t.Fatal("expected unknown special champion id validation error")
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
	if received.PositionPreferences["firstPreference"] != "MIDDLE" || received.PositionPreferences["secondPreference"] != "TOP" {
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

func TestSetRolesFallsBackToLegacyPayload(t *testing.T) {
	var payloads []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || (r.URL.Path != "/lol-lobby/v1/lobby/members/localMember/position-preferences" && r.URL.Path != "/lol-lobby/v2/lobby/members/localMember/position-preferences") {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		payloads = append(payloads, payload)
		if r.URL.Path == "/lol-lobby/v2/lobby/members/localMember/position-preferences" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		preferences := payload["positionPreferences"].(map[string]any)
		if _, ok := preferences["firstPositionPreference"]; !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	if err := testLockfile(server.URL).AutoSetRoles(context.Background(), "TOP", "UTILITY"); err != nil {
		t.Fatal(err)
	}
	if len(payloads) != 3 {
		t.Fatalf("payload attempts = %d, want current v1/v2 then legacy v1", len(payloads))
	}
	legacy := payloads[2]["positionPreferences"].(map[string]any)
	if legacy["firstPositionPreference"] != "TOP" || legacy["secondPositionPreference"] != "UTILITY" {
		t.Fatalf("legacy roles payload = %#v", legacy)
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

func TestLootRecipeDiscoveryAndCraft(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lol-loot/v1/recipes/initial-item/MATERIAL_key":
			_, _ = w.Write([]byte(`[{"recipeName":"KEY_TO_CHEST","type":"OPEN"}]`))
		case r.Method == http.MethodPost && r.URL.Path == "/lol-loot/v1/recipes/KEY_TO_CHEST/craft":
			if got := r.URL.Query().Get("repeat"); got != "2" {
				t.Fatalf("repeat = %q, want 2", got)
			}
			var lootIDs []string
			if err := json.NewDecoder(r.Body).Decode(&lootIDs); err != nil {
				t.Fatal(err)
			}
			if len(lootIDs) != 1 || lootIDs[0] != "MATERIAL_key" {
				t.Fatalf("loot ids = %#v", lootIDs)
			}
			_, _ = w.Write([]byte(`{"crafted":true}`))
		default:
			t.Fatalf("unexpected request = %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	lockfile := testLockfile(server.URL)
	body, err := lockfile.FetchLCULootRecipes(context.Background(), "MATERIAL_key")
	if err != nil || !strings.Contains(string(body), "KEY_TO_CHEST") {
		t.Fatalf("recipe discovery body = %s, err = %v", body, err)
	}
	body, err = lockfile.CraftLCULootRecipe(context.Background(), "KEY_TO_CHEST", []string{"MATERIAL_key"}, 2)
	if err != nil || !strings.Contains(string(body), `"crafted":true`) {
		t.Fatalf("craft body = %s, err = %v", body, err)
	}
}

func TestFetchLCUWalletFallsBackToStorePlugin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lol-login/v1/wallet":
			http.Error(w, "missing", http.StatusNotFound)
		case "/lol-store/v1/wallet":
			_, _ = w.Write([]byte(`{"rp":840,"ip":12000}`))
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	body, err := testLockfile(server.URL).FetchLCUWallet(context.Background())
	if err != nil || !strings.Contains(string(body), `"rp":840`) {
		t.Fatalf("wallet body = %s, err = %v", body, err)
	}
}

func TestLootCraftValidation(t *testing.T) {
	lockfile := testLockfile("http://127.0.0.1:1")
	if _, err := lockfile.FetchLCULootRecipes(context.Background(), " "); err == nil {
		t.Fatal("expected empty loot id to fail")
	}
	if _, err := lockfile.CraftLCULootRecipe(context.Background(), "", []string{"loot"}, 1); err == nil {
		t.Fatal("expected empty recipe name to fail")
	}
	if _, err := lockfile.CraftLCULootRecipe(context.Background(), "recipe", []string{"loot"}, 101); err == nil {
		t.Fatal("expected repeat above the safety limit to fail")
	}
	if _, err := lockfile.CraftLCULootRecipe(context.Background(), "recipe", nil, 1); err == nil {
		t.Fatal("expected an empty loot id list to fail")
	}
}

func TestCollectOwnedProfileIconIDsHonorsOwnershipFields(t *testing.T) {
	var payload any
	if err := json.Unmarshal([]byte(`[
		{"summonerIconId":12,"owned":true},
		{"itemId":"24","quantity":1},
		{"iconId":36,"ownershipType":"OWNED"},
		{"profileIconId":48,"owned":false},
		{"itemId":60,"status":"NOT_OWNED"},
		{"id":72,"ownershipType":"LOCKED"}
	]`), &payload); err != nil {
		t.Fatal(err)
	}
	ids := make(map[int]struct{})
	collectOwnedProfileIconIDs(payload, ids)
	got := sortedProfileIconIDs(ids)
	if len(got) != 3 || got[0] != 12 || got[1] != 24 || got[2] != 36 {
		t.Fatalf("owned profile icons = %v, want [12 24 36]", got)
	}
}

func TestCollectOwnedProfileIconIDsSupportsPrimitiveInventory(t *testing.T) {
	var payload any
	if err := json.Unmarshal([]byte(`{"items":[101,"202",303]}`), &payload); err != nil {
		t.Fatal(err)
	}
	ids := make(map[int]struct{})
	collectOwnedProfileIconIDs(payload, ids)
	got := sortedProfileIconIDs(ids)
	if len(got) != 3 || got[0] != 101 || got[1] != 202 || got[2] != 303 {
		t.Fatalf("owned profile icons = %v, want [101 202 303]", got)
	}
}

func TestFetchLCUProfileIconInventoryUsesOwnedCollection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lol-summoner/v1/current-summoner":
			_, _ = w.Write([]byte(`{"summonerId":99,"profileIconId":7}`))
		case "/lol-collections/v1/inventories/99/summoner-icons":
			_, _ = w.Write([]byte(`{"icons":[7,8],"summonerId":99}`))
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
	defer server.Close()

	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	inventory, err := testLockfile(server.URL).FetchLCUProfileIconInventory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !inventory.Complete || inventory.Source != "/lol-collections/v1/inventories/99/summoner-icons" {
		t.Fatalf("inventory metadata = %+v", inventory)
	}
	if len(inventory.IconIDs) != 2 || inventory.IconIDs[0] != 7 || inventory.IconIDs[1] != 8 {
		t.Fatalf("inventory icons = %v, want [7 8]", inventory.IconIDs)
	}
}
