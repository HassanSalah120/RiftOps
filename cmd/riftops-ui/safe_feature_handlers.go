package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/featurestore"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

func writeSafeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}

func safeLCU(w http.ResponseWriter) *riotclient.Lockfile {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		httpError(w, "League Client is not connected", http.StatusServiceUnavailable)
	}
	return lf
}

func currentAccountKey(ctx context.Context, lf *riotclient.Lockfile) (string, error) {
	summoner, err := lf.FetchLCUSummoner(ctx)
	if err != nil || summoner == nil || strings.TrimSpace(summoner.PUUID) == "" {
		if err == nil {
			err = fmt.Errorf("current account PUUID is unavailable")
		}
		return "", err
	}
	return featurestore.AccountKey(summoner.PUUID), nil
}

func requireFeatureStore(w http.ResponseWriter) *featurestore.Store {
	if featureData == nil {
		httpError(w, "RiftOps feature storage is unavailable", http.StatusServiceUnavailable)
	}
	return featureData
}

type safeSocialResponse struct {
	Friends        json.RawMessage `json:"friends"`
	FriendRequests json.RawMessage `json:"friendRequests"`
	FriendGroups   json.RawMessage `json:"friendGroups"`
	Lobby          json.RawMessage `json:"lobby,omitempty"`
	FetchedAt      time.Time       `json:"fetchedAt"`
}

func lcuSocialHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	friends, err := lf.FetchLCUFriends(ctx)
	if err != nil {
		httpError(w, "Could not load League friends", http.StatusServiceUnavailable)
		return
	}
	result := safeSocialResponse{Friends: friends, FriendRequests: json.RawMessage(`[]`), FriendGroups: json.RawMessage(`[]`), FetchedAt: time.Now().UTC()}
	if requests, requestErr := lf.FetchFriendRequests(ctx); requestErr == nil && json.Valid(requests) {
		result.FriendRequests = requests
	}
	if groups, groupsErr := lf.FetchFriendGroups(ctx); groupsErr == nil && json.Valid(groups) {
		result.FriendGroups = groups
	}
	if lobby, lobbyErr := lf.FetchCurrentLobby(ctx); lobbyErr == nil && json.Valid(lobby) {
		result.Lobby = lobby
	}
	writeSafeJSON(w, result)
}

// lcuCapabilitiesHandler is deliberately a small, redacted diagnostic. It
// reports route availability only; it never returns lockfile credentials or
// accepts arbitrary route/method input.
func lcuCapabilitiesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	statuses := make([]map[string]string, 0, 4)
	if _, err := lf.GetGameflowPhase(ctx); err == nil {
		statuses = append(statuses, map[string]string{"id": "gameflow", "status": "supported"})
	} else {
		statuses = append(statuses, map[string]string{"id": "gameflow", "status": "unavailable", "detail": "League did not expose the gameflow route"})
	}
	probes := []struct {
		id    string
		probe func(context.Context) ([]byte, error)
	}{
		{id: "social", probe: lf.FetchLCUFriends},
		{id: "profile-icons", probe: func(ctx context.Context) ([]byte, error) {
			return lf.DoRequest(ctx, http.MethodGet, "/lol-game-data/assets/v1/summoner-icons.json")
		}},
		{id: "pending-rewards", probe: lf.FetchPendingRewards},
	}
	for _, capability := range probes {
		if _, err := capability.probe(ctx); err == nil {
			statuses = append(statuses, map[string]string{"id": capability.id, "status": "supported"})
		} else {
			statuses = append(statuses, map[string]string{"id": capability.id, "status": "unavailable", "detail": "Unavailable for this League patch"})
		}
	}
	writeSafeJSON(w, statuses)
}

func lcuFriendRequestActionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		PID       string `json:"pid"`
		Action    string `json:"action"`
		Direction string `json:"direction"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid friend request action", http.StatusBadRequest)
		return
	}
	body.PID = strings.TrimSpace(body.PID)
	body.Action = strings.ToLower(strings.TrimSpace(body.Action))
	if body.Action == "accept" || body.Direction != "" {
		direction := body.Direction
		if direction == "" {
			direction = "both"
		}
		if err := lf.UpdateFriendRequest(r.Context(), body.PID, direction); err != nil {
			httpError(w, "League rejected the friend request", http.StatusBadGateway)
			return
		}
	} else if body.Action == "decline" || body.Action == "delete" || body.Action == "remove" {
		if err := lf.DeleteFriendRequest(r.Context(), body.PID); err != nil {
			httpError(w, "League rejected the friend request removal", http.StatusBadGateway)
			return
		}
	} else {
		httpError(w, "Action must be accept, decline, or delete", http.StatusBadRequest)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuSocialInviteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		SummonerIDs []string `json:"summonerIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.SummonerIDs) == 0 {
		httpError(w, "Select at least one friend to invite", http.StatusBadRequest)
		return
	}
	maxTargets := 20
	if remoteRequest(r) {
		maxTargets = 1
	}
	if len(body.SummonerIDs) > maxTargets {
		httpError(w, fmt.Sprintf("You can invite at most %d friend(s) at a time", maxTargets), http.StatusBadRequest)
		return
	}
	clean := make([]string, 0, len(body.SummonerIDs))
	seen := make(map[string]struct{}, len(body.SummonerIDs))
	for _, id := range body.SummonerIDs {
		id = strings.TrimSpace(id)
		if _, err := strconv.ParseInt(id, 10, 64); err != nil {
			httpError(w, "Summoner IDs must be numeric", http.StatusBadRequest)
			return
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		clean = append(clean, id)
	}
	for index, id := range clean {
		if index > 0 {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
		if err := lf.InviteFriends(r.Context(), []string{id}); err != nil {
			httpError(w, "League rejected one or more lobby invitations", http.StatusBadGateway)
			return
		}
	}
	writeSafeJSON(w, map[string]any{"ok": true, "invited": len(clean)})
}

func profilePresetsHandler(w http.ResponseWriter, r *http.Request) {
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	snapshot := store.Snapshot()
	if r.Method == http.MethodGet {
		writeSafeJSON(w, snapshot.ProfilePresets[accountKey])
		return
	}
	if r.Method == http.MethodDelete {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			httpError(w, "Preset id is required", http.StatusBadRequest)
			return
		}
		if err := store.Update(func(data *featurestore.Data) error {
			presets := data.ProfilePresets[accountKey]
			filtered := presets[:0]
			found := false
			for _, preset := range presets {
				if preset.ID == id {
					found = true
					continue
				}
				filtered = append(filtered, preset)
			}
			if !found {
				return fmt.Errorf("profile preset was not found")
			}
			data.ProfilePresets[accountKey] = filtered
			return nil
		}); err != nil {
			httpError(w, "Could not delete profile preset", http.StatusNotFound)
			return
		}
		writeSafeJSON(w, map[string]bool{"ok": true})
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var preset featurestore.ProfilePreset
	if err := json.NewDecoder(r.Body).Decode(&preset); err != nil {
		httpError(w, "Invalid profile preset", http.StatusBadRequest)
		return
	}
	preset.ID = strings.TrimSpace(preset.ID)
	preset.Name = strings.TrimSpace(preset.Name)
	preset.AccountKey = accountKey
	if preset.ID == "" {
		preset.ID = "profile-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	if len(preset.ID) > 80 || preset.Name == "" || len([]rune(preset.Name)) > 48 || len([]rune(preset.StatusMessage)) > 255 {
		httpError(w, "Preset name, id, or status message is invalid", http.StatusBadRequest)
		return
	}
	if preset.IconID < 0 || preset.BackgroundSkinID < 0 || preset.TitleID < 0 || preset.BannerID < 0 || len(preset.TokenIDs) > 3 {
		httpError(w, "Preset asset ids are invalid", http.StatusBadRequest)
		return
	}
	if err := store.Update(func(data *featurestore.Data) error {
		presets := data.ProfilePresets[accountKey]
		for index := range presets {
			if presets[index].ID == preset.ID {
				presets[index] = preset
				data.ProfilePresets[accountKey] = presets
				return nil
			}
		}
		data.ProfilePresets[accountKey] = append(presets, preset)
		return nil
	}); err != nil {
		httpError(w, "Could not save profile preset", http.StatusInternalServerError)
		return
	}
	writeSafeJSON(w, preset)
}

func profilePresetApplyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
		httpError(w, "Preset id is required", http.StatusBadRequest)
		return
	}
	var selected *featurestore.ProfilePreset
	data := store.Snapshot()
	for index := range data.ProfilePresets[accountKey] {
		preset := data.ProfilePresets[accountKey][index]
		if preset.ID == strings.TrimSpace(body.ID) {
			selected = &preset
			break
		}
	}
	if selected == nil {
		httpError(w, "Profile preset was not found", http.StatusNotFound)
		return
	}
	result := map[string]string{}
	if selected.IconID > 0 {
		inventory, inventoryErr := lf.FetchLCUProfileIconInventory(r.Context())
		if inventoryErr != nil || !containsInt(inventory.IconIDs, selected.IconID) {
			result["icon"] = "skipped: icon is not verified as owned"
		} else if applyErr := lf.SetProfileIcon(r.Context(), selected.IconID); applyErr != nil {
			result["icon"] = "failed"
		} else {
			result["icon"] = "applied"
		}
	}
	if selected.BackgroundSkinID > 0 {
		if applyErr := lf.SetProfileBackground(r.Context(), selected.BackgroundSkinID); applyErr != nil {
			result["background"] = "failed"
		} else {
			result["background"] = "applied"
		}
	}
	if selected.StatusMessage != "" {
		if applyErr := lf.SetStatusMessage(r.Context(), selected.StatusMessage); applyErr != nil {
			result["statusMessage"] = "failed"
		} else {
			result["statusMessage"] = "applied"
		}
	}
	if selected.TitleID > 0 || selected.BannerID > 0 || len(selected.TokenIDs) > 0 {
		result["regalia"] = "unavailable: this League client does not expose a safe owned-regalia mutation"
	}
	writeSafeJSON(w, map[string]any{"ok": true, "preset": selected, "results": result})
}

func safePresetPreviewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
		httpError(w, "Invalid preview payload", http.StatusBadRequest)
		return
	}
	var proposed *featurestore.ProfilePreset
	for _, preset := range store.Snapshot().ProfilePresets[accountKey] {
		if preset.ID == strings.TrimSpace(body.ID) {
			copy := preset
			proposed = &copy
			break
		}
	}
	if proposed == nil {
		httpError(w, "Profile preset was not found", http.StatusNotFound)
		return
	}
	current, currentErr := lf.FetchLCUProfile(r.Context())
	if currentErr != nil || current == nil || current.Summoner == nil {
		httpError(w, "Current profile is unavailable for this League patch", http.StatusServiceUnavailable)
		return
	}
	currentView := map[string]any{"iconId": 0}
	currentView["iconId"] = current.Summoner.ProfileIconID
	writeSafeJSON(w, map[string]any{"expiresAt": time.Now().Add(2 * time.Minute).UTC(), "current": currentView, "proposed": proposed, "requiresConfirmation": true})
}

func lcuCustomBotsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	if r.Method == http.MethodGet {
		body, err := lf.FetchCustomBots(r.Context())
		if err != nil {
			httpError(w, "Custom-game bots are unavailable", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ChampionID int    `json:"championId"`
		Difficulty string `json:"difficulty"`
		TeamID     string `json:"teamId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid bot payload", http.StatusBadRequest)
		return
	}
	if err := lf.AddCustomBot(r.Context(), body.ChampionID, body.Difficulty, body.TeamID); err != nil {
		httpError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuCustomBotsAddHandler(w http.ResponseWriter, r *http.Request) { lcuCustomBotsHandler(w, r) }

func lcuProfileCustomizationHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	metadata, metadataErr := lf.DoRequest(r.Context(), http.MethodGet, "/lol-game-data/assets/v1/summoner-icons.json")
	inventory, inventoryErr := lf.FetchLCUProfileIconInventory(r.Context())
	if metadataErr != nil || inventoryErr != nil || !json.Valid(metadata) {
		httpError(w, "Profile customization is unavailable for this League patch", http.StatusServiceUnavailable)
		return
	}
	writeSafeJSON(w, map[string]any{"icons": json.RawMessage(metadata), "ownedIconIds": inventory.IconIDs, "ownershipComplete": inventory.Complete})
}

func lcuProfileRegaliaHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	regalia, regaliaErr := lf.FetchProfileRegalia(r.Context())
	titles, titlesErr := lf.FetchChallengeTitles(r.Context())
	tokens, tokensErr := lf.FetchChallengeTokens(r.Context())
	if regaliaErr != nil && titlesErr != nil && tokensErr != nil {
		httpError(w, "Profile regalia is unavailable for this League patch", http.StatusServiceUnavailable)
		return
	}
	if !json.Valid(regalia) {
		regalia = []byte("null")
	}
	if !json.Valid(titles) {
		titles = []byte("null")
	}
	if !json.Valid(tokens) {
		tokens = []byte("null")
	}
	writeSafeJSON(w, map[string]any{"regalia": json.RawMessage(regalia), "titles": json.RawMessage(titles), "tokens": json.RawMessage(tokens), "mutation": "unavailable until League exposes a stable ownership-checked route"})
}

func lcuChampSelectMuteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		PUUID string `json:"puuid"`
		Muted *bool  `json:"muted,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid mute payload", http.StatusBadRequest)
		return
	}
	payload := map[string]any{"puuid": strings.TrimSpace(body.PUUID)}
	if body.Muted != nil {
		payload["muted"] = *body.Muted
	}
	if err := lf.TogglePlayerMuted(r.Context(), payload); err != nil {
		httpError(w, "League rejected the mute action", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuBalanceCatalogHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	httpError(w, "Unavailable for this League patch", http.StatusServiceUnavailable)
}

func lcuReplayHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	gameID := strings.TrimSpace(r.URL.Query().Get("gameId"))
	if gameID == "" {
		var body struct {
			GameID string `json:"gameId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gameID = strings.TrimSpace(body.GameID)
	}
	if parsed, err := strconv.ParseInt(gameID, 10, 64); err != nil || parsed <= 0 {
		httpError(w, "gameId must be a positive integer", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		body, err := lf.FetchReplayMetadata(r.Context(), gameID)
		if err != nil {
			httpError(w, "Replay metadata is unavailable", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	case http.MethodPost:
		action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
		var err error
		if action == "download" {
			err = lf.DownloadReplay(r.Context(), gameID)
		} else if action == "watch" {
			if phase, phaseErr := lf.GetGameflowPhase(r.Context()); phaseErr != nil || phase != "None" && phase != "Lobby" {
				httpError(w, "Watch is only available while League is idle", http.StatusConflict)
				return
			}
			// Revalidate availability immediately before opening the replay. A
			// match can expire or be removed between the list refresh and this
			// action; never tell the client that Watch succeeded in that case.
			if metadata, metadataErr := lf.FetchReplayMetadata(r.Context(), gameID); metadataErr != nil || !json.Valid(metadata) {
				httpError(w, "Replay is no longer available", http.StatusConflict)
				return
			}
			err = lf.WatchReplay(r.Context(), gameID)
		} else {
			httpError(w, "action must be download or watch", http.StatusBadRequest)
			return
		}
		if err != nil {
			httpError(w, "League rejected the replay action", http.StatusBadGateway)
			return
		}
		writeSafeJSON(w, map[string]any{"ok": true, "gameId": gameID, "action": action})
	default:
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func replayRouteAlias(w http.ResponseWriter, r *http.Request, action string) {
	query := r.URL.Query()
	query.Set("action", action)
	r.URL.RawQuery = query.Encode()
	lcuReplayHandler(w, r)
}

func lcuReplayStatusHandler(w http.ResponseWriter, r *http.Request) { replayRouteAlias(w, r, "") }
func lcuReplayDownloadHandler(w http.ResponseWriter, r *http.Request) {
	replayRouteAlias(w, r, "download")
}
func lcuReplayWatchHandler(w http.ResponseWriter, r *http.Request) { replayRouteAlias(w, r, "watch") }

func lcuGameSettingsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	if r.Method == http.MethodGet {
		general, generalErr := lf.FetchGameSettings(r.Context())
		input, inputErr := lf.FetchInputSettings(r.Context())
		if generalErr != nil || inputErr != nil {
			httpError(w, "League settings are unavailable", http.StatusBadGateway)
			return
		}
		writeSafeJSON(w, map[string]json.RawMessage{"general": general, "input": input})
		return
	}
	if r.Method != http.MethodPatch {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		General json.RawMessage `json:"general"`
		Input   json.RawMessage `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid settings backup", http.StatusBadRequest)
		return
	}
	if len(body.General) > 0 {
		if err := lf.PatchGameSettings(r.Context(), body.General); err != nil {
			httpError(w, "Could not restore general League settings", http.StatusBadGateway)
			return
		}
	}
	if len(body.Input) > 0 {
		if err := lf.PatchInputSettings(r.Context(), body.Input); err != nil {
			httpError(w, "Could not restore League input settings", http.StatusBadGateway)
			return
		}
	}
	if err := lf.SaveGameSettings(r.Context()); err != nil {
		httpError(w, "Could not save restored League settings", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuPendingRewardsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	if r.Method == http.MethodGet {
		body, err := lf.FetchPendingRewards(r.Context())
		if err != nil {
			httpError(w, "Pending rewards are unavailable", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		GrantID       string   `json:"grantId"`
		RewardGroupID string   `json:"rewardGroupId"`
		Selections    []string `json:"selections"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid reward selection", http.StatusBadRequest)
		return
	}
	if err := lf.SelectReward(r.Context(), body.GrantID, body.RewardGroupID, body.Selections); err != nil {
		httpError(w, "League rejected the reward selection", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func preparationPresetsHandler(w http.ResponseWriter, r *http.Request) {
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodGet {
		writeSafeJSON(w, store.Snapshot().PreparationPresets[accountKey])
		return
	}
	if r.Method == http.MethodDelete {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			httpError(w, "Preset id is required", http.StatusBadRequest)
			return
		}
		err := store.Update(func(data *featurestore.Data) error {
			presets := data.PreparationPresets[accountKey]
			filtered := presets[:0]
			found := false
			for _, preset := range presets {
				if preset.ID == id {
					found = true
					continue
				}
				filtered = append(filtered, preset)
			}
			if !found {
				return fmt.Errorf("preparation preset was not found")
			}
			data.PreparationPresets[accountKey] = filtered
			return nil
		})
		if err != nil {
			httpError(w, "Could not delete preparation preset", http.StatusNotFound)
			return
		}
		writeSafeJSON(w, map[string]bool{"ok": true})
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var preset featurestore.PreparationPreset
	if err := json.NewDecoder(r.Body).Decode(&preset); err != nil {
		httpError(w, "Invalid preparation preset", http.StatusBadRequest)
		return
	}
	preset.ID, preset.Name, preset.AccountKey = strings.TrimSpace(preset.ID), strings.TrimSpace(preset.Name), accountKey
	if preset.ID == "" {
		preset.ID = "prep-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	if len(preset.ID) > 80 || preset.Name == "" || len([]rune(preset.Name)) > 48 || len(preset.ItemIDs) > 6 {
		httpError(w, "Preset name, id, or item list is invalid", http.StatusBadRequest)
		return
	}
	for _, value := range []int{preset.ChampionID, preset.RunePageID, preset.FallbackRunePageID, preset.Spell1ID, preset.Spell2ID} {
		if value < 0 {
			httpError(w, "Preset identifiers must be positive", http.StatusBadRequest)
			return
		}
	}
	if err := store.Update(func(data *featurestore.Data) error {
		presets := data.PreparationPresets[accountKey]
		for index := range presets {
			if presets[index].ID == preset.ID {
				presets[index] = preset
				data.PreparationPresets[accountKey] = presets
				return nil
			}
		}
		data.PreparationPresets[accountKey] = append(presets, preset)
		return nil
	}); err != nil {
		httpError(w, "Could not save preparation preset", http.StatusInternalServerError)
		return
	}
	writeSafeJSON(w, preset)
}

func preparationPresetApplyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
		httpError(w, "Preset id is required", http.StatusBadRequest)
		return
	}
	data := store.Snapshot()
	var selected *featurestore.PreparationPreset
	for _, preset := range data.PreparationPresets[accountKey] {
		if preset.ID == strings.TrimSpace(body.ID) {
			copy := preset
			selected = &copy
			break
		}
	}
	if selected == nil {
		httpError(w, "Preparation preset was not found", http.StatusNotFound)
		return
	}
	result := map[string]string{}
	if selected.RunePageID > 0 {
		if applyErr := lf.SetCurrentRunePage(r.Context(), selected.RunePageID); applyErr != nil {
			result["runePage"] = "failed"
		} else {
			result["runePage"] = "applied"
		}
	}
	if selected.FallbackRunePageID > 0 {
		result["fallbackRunePage"] = "available for fallback pick"
	}
	if selected.Spell1ID > 0 || selected.Spell2ID > 0 {
		if phase, phaseErr := lf.GetGameflowPhase(r.Context()); phaseErr == nil && phase == "ChampSelect" {
			if applyErr := lf.UpdateChampSelectSelection(r.Context(), selected.Spell1ID, selected.Spell2ID, 0); applyErr != nil {
				result["spells"] = "failed"
			} else {
				result["spells"] = "applied"
			}
		} else {
			result["spells"] = "waiting for champion select"
		}
	}
	if len(selected.ItemIDs) > 0 {
		result["items"] = "saved plan; item-set apply is explicit"
	}
	writeSafeJSON(w, map[string]any{"ok": true, "preset": selected, "results": result})
}

func lobbyPresetsHandler(w http.ResponseWriter, r *http.Request) {
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	if r.Method == http.MethodGet {
		writeSafeJSON(w, store.Snapshot().LobbyPresets)
		return
	}
	if r.Method == http.MethodDelete {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			httpError(w, "Preset id is required", http.StatusBadRequest)
			return
		}
		if err := store.Update(func(data *featurestore.Data) error {
			filtered := data.LobbyPresets[:0]
			found := false
			for _, preset := range data.LobbyPresets {
				if preset.ID == id {
					found = true
					continue
				}
				filtered = append(filtered, preset)
			}
			if !found {
				return fmt.Errorf("lobby preset was not found")
			}
			data.LobbyPresets = filtered
			return nil
		}); err != nil {
			httpError(w, "Could not delete lobby preset", http.StatusNotFound)
			return
		}
		writeSafeJSON(w, map[string]bool{"ok": true})
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var preset featurestore.LobbyPreset
	if err := json.NewDecoder(r.Body).Decode(&preset); err != nil {
		httpError(w, "Invalid lobby preset", http.StatusBadRequest)
		return
	}
	preset.ID, preset.Name = strings.TrimSpace(preset.ID), strings.TrimSpace(preset.Name)
	if preset.ID == "" {
		preset.ID = "lobby-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	if len(preset.ID) > 80 || preset.Name == "" || len([]rune(preset.Name)) > 48 || preset.QueueID <= 0 {
		httpError(w, "Lobby preset name, id, and queue are required", http.StatusBadRequest)
		return
	}
	if err := store.Update(func(data *featurestore.Data) error {
		for index := range data.LobbyPresets {
			if data.LobbyPresets[index].ID == preset.ID {
				data.LobbyPresets[index] = preset
				return nil
			}
		}
		data.LobbyPresets = append(data.LobbyPresets, preset)
		return nil
	}); err != nil {
		httpError(w, "Could not save lobby preset", http.StatusInternalServerError)
		return
	}
	writeSafeJSON(w, preset)
}

func lobbyPresetApplyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
		httpError(w, "Preset id is required", http.StatusBadRequest)
		return
	}
	var selected *featurestore.LobbyPreset
	for _, preset := range store.Snapshot().LobbyPresets {
		if preset.ID == strings.TrimSpace(body.ID) {
			copy := preset
			selected = &copy
			break
		}
	}
	if selected == nil {
		httpError(w, "Lobby preset was not found", http.StatusNotFound)
		return
	}
	if selected.QueueID <= 0 {
		httpError(w, "Lobby queue is invalid", http.StatusBadRequest)
		return
	}
	if err := lf.CreateQueueLobby(r.Context(), selected.QueueID); err != nil {
		httpError(w, "League rejected the lobby preset", http.StatusBadGateway)
		return
	}
	if selected.FirstRole != "" && selected.SecondRole != "" {
		_ = lf.AutoSetRoles(r.Context(), selected.FirstRole, selected.SecondRole)
	}
	writeSafeJSON(w, map[string]any{"ok": true, "preset": selected})
}

func lcuItemSetsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	summoner, err := lf.FetchLCUSummoner(r.Context())
	if err != nil || summoner == nil {
		httpError(w, "League account is unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodGet {
		if r.URL.Query().Get("snapshots") == "1" {
			store := requireFeatureStore(w)
			if store == nil {
				return
			}
			key, keyErr := currentAccountKey(r.Context(), lf)
			if keyErr != nil {
				httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
				return
			}
			snapshots := store.Snapshot().ItemSetSnapshots[key]
			for index := range snapshots {
				snapshots[index].Payload = nil
			}
			writeSafeJSON(w, snapshots)
			return
		}
		body, fetchErr := lf.FetchItemSets(r.Context(), summoner.SummonerID)
		if fetchErr != nil {
			httpError(w, "League item sets are unavailable", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		RollbackID  string           `json:"rollbackId"`
		Name        string           `json:"name"`
		ChampionIDs []string         `json:"championIds"`
		Mode        string           `json:"mode"`
		Map         string           `json:"map"`
		Blocks      []map[string]any `json:"blocks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		httpError(w, "Invalid item-set request", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(request.RollbackID) != "" {
		store := requireFeatureStore(w)
		if store == nil {
			return
		}
		key := featurestore.AccountKey(summoner.PUUID)
		var snapshot *featurestore.ItemSetSnapshot
		for _, candidate := range store.Snapshot().ItemSetSnapshots[key] {
			if candidate.ID == strings.TrimSpace(request.RollbackID) {
				copy := candidate
				snapshot = &copy
				break
			}
		}
		if snapshot == nil || !json.Valid(snapshot.Payload) {
			httpError(w, "Item-set rollback snapshot was not found", http.StatusNotFound)
			return
		}
		if err := lf.UpdateItemSets(r.Context(), summoner.SummonerID, snapshot.Payload); err != nil {
			httpError(w, "League rejected the item-set rollback", http.StatusBadGateway)
			return
		}
		writeSafeJSON(w, map[string]any{"ok": true, "rollbackId": snapshot.ID})
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" || len([]rune(request.Name)) > 48 || len(request.Blocks) > 20 {
		httpError(w, "Item-set name or blocks are invalid", http.StatusBadRequest)
		return
	}
	current, err := lf.FetchItemSets(r.Context(), summoner.SummonerID)
	if err != nil {
		httpError(w, "League item sets are unavailable", http.StatusBadGateway)
		return
	}
	var wrapper map[string]any
	if err := json.Unmarshal(current, &wrapper); err != nil {
		httpError(w, "League returned an invalid item-set document", http.StatusBadGateway)
		return
	}
	sets, ok := wrapper["itemSets"].([]any)
	if !ok {
		sets = []any{}
	}
	identity, _ := json.Marshal(struct {
		Name        string           `json:"name"`
		ChampionIDs []string         `json:"championIds"`
		Mode        string           `json:"mode"`
		Map         string           `json:"map"`
		Blocks      []map[string]any `json:"blocks"`
	}{request.Name, request.ChampionIDs, request.Mode, request.Map, request.Blocks})
	identityHash := sha256.Sum256(identity)
	managed := map[string]any{"uid": "riftops-" + hex.EncodeToString(identityHash[:8]), "name": "RiftOps: " + request.Name, "championIds": request.ChampionIDs, "mode": request.Mode, "map": request.Map, "blocks": request.Blocks, "type": "custom"}
	replaced := false
	for index, existing := range sets {
		if existingMap, ok := existing.(map[string]any); ok && existingMap["uid"] == managed["uid"] {
			sets[index] = managed
			replaced = true
			break
		}
	}
	if !replaced {
		sets = append(sets, managed)
	}
	wrapper["itemSets"] = sets
	encoded, _ := json.Marshal(wrapper)
	// Keep a bounded recovery point before every managed write. The snapshot is
	// local-only and can be used by a future explicit rollback action.
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	if err := store.Update(func(data *featurestore.Data) error {
		items := append([]featurestore.ItemSetSnapshot{{
			ID: "itemset-" + strconv.FormatInt(time.Now().UnixNano(), 36), AccountKey: featurestore.AccountKey(summoner.PUUID), CreatedAt: time.Now().UTC(), Payload: append(json.RawMessage(nil), current...),
		}}, data.ItemSetSnapshots[featurestore.AccountKey(summoner.PUUID)]...)
		if len(items) > 10 {
			items = items[:10]
		}
		data.ItemSetSnapshots[featurestore.AccountKey(summoner.PUUID)] = items
		return nil
	}); err != nil {
		httpError(w, "Could not create an item-set recovery snapshot; no changes were made", http.StatusInternalServerError)
		return
	}
	if err := lf.UpdateItemSets(r.Context(), summoner.SummonerID, encoded); err != nil {
		httpError(w, "League rejected the managed item set", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]any{"ok": true, "itemSet": managed})
}

type settingsBackupPayload struct {
	General json.RawMessage `json:"general"`
	Input   json.RawMessage `json:"input"`
}

func clientSettingsBackupsHandler(w http.ResponseWriter, r *http.Request) {
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodGet {
		backups := store.Snapshot().SettingsBackups[accountKey]
		result := make([]featurestore.ClientSettingsBackup, len(backups))
		copy(result, backups)
		for index := range result {
			result[index].Payload = nil
		}
		writeSafeJSON(w, result)
		return
	}
	if r.Method == http.MethodDelete {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			httpError(w, "Backup id is required", http.StatusBadRequest)
			return
		}
		if err := store.Update(func(data *featurestore.Data) error {
			filtered := data.SettingsBackups[accountKey][:0]
			found := false
			for _, backup := range data.SettingsBackups[accountKey] {
				if backup.ID == id {
					found = true
					continue
				}
				filtered = append(filtered, backup)
			}
			if !found {
				return fmt.Errorf("backup was not found")
			}
			data.SettingsBackups[accountKey] = filtered
			return nil
		}); err != nil {
			httpError(w, "Could not delete settings backup", http.StatusNotFound)
			return
		}
		writeSafeJSON(w, map[string]bool{"ok": true})
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid backup request", http.StatusBadRequest)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len([]rune(body.Name)) > 48 {
		httpError(w, "Backup name is invalid", http.StatusBadRequest)
		return
	}
	general, generalErr := lf.FetchGameSettings(r.Context())
	input, inputErr := lf.FetchInputSettings(r.Context())
	if generalErr != nil || inputErr != nil {
		httpError(w, "League settings are unavailable", http.StatusBadGateway)
		return
	}
	backup := featurestore.ClientSettingsBackup{ID: "backup-" + strconv.FormatInt(time.Now().UnixNano(), 36), Name: body.Name, AccountKey: accountKey, CreatedAt: time.Now().UTC(), Payload: mustJSON(settingsBackupPayload{General: general, Input: input})}
	if err := store.Update(func(data *featurestore.Data) error {
		backups := append(data.SettingsBackups[accountKey], backup)
		if len(backups) > 10 {
			backups = backups[len(backups)-10:]
		}
		data.SettingsBackups[accountKey] = backups
		return nil
	}); err != nil {
		httpError(w, "Could not save settings backup", http.StatusInternalServerError)
		return
	}
	backup.Payload = nil
	writeSafeJSON(w, backup)
}

func clientSettingsBackupPreviewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Backup id is required", http.StatusBadRequest)
		return
	}
	var backup *featurestore.ClientSettingsBackup
	for _, candidate := range store.Snapshot().SettingsBackups[accountKey] {
		if candidate.ID == strings.TrimSpace(body.ID) {
			copy := candidate
			backup = &copy
			break
		}
	}
	if backup == nil {
		httpError(w, "Settings backup was not found", http.StatusNotFound)
		return
	}
	currentGeneral, generalErr := lf.FetchGameSettings(r.Context())
	currentInput, inputErr := lf.FetchInputSettings(r.Context())
	if generalErr != nil || inputErr != nil {
		httpError(w, "Current League settings are unavailable", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]any{"backup": backup, "current": settingsBackupPayload{General: currentGeneral, Input: currentInput}, "restoreConfirmation": "RESTORE SETTINGS"})
}

func clientSettingsBackupRestoreHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	accountKey, err := currentAccountKey(r.Context(), lf)
	if err != nil {
		httpError(w, "The signed-in account is unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		ID           string `json:"id"`
		Confirmation string `json:"confirmation"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid restore request", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Confirmation) != "RESTORE SETTINGS" {
		httpError(w, "Type RESTORE SETTINGS to confirm", http.StatusBadRequest)
		return
	}
	var backup *featurestore.ClientSettingsBackup
	for _, candidate := range store.Snapshot().SettingsBackups[accountKey] {
		if candidate.ID == strings.TrimSpace(body.ID) {
			copy := candidate
			backup = &copy
			break
		}
	}
	if backup == nil {
		httpError(w, "Settings backup was not found", http.StatusNotFound)
		return
	}
	currentGeneral, generalErr := lf.FetchGameSettings(r.Context())
	currentInput, inputErr := lf.FetchInputSettings(r.Context())
	if generalErr != nil || inputErr != nil {
		httpError(w, "Current League settings are unavailable", http.StatusBadGateway)
		return
	}
	var payload settingsBackupPayload
	if err := json.Unmarshal(backup.Payload, &payload); err != nil {
		httpError(w, "Settings backup is invalid", http.StatusBadGateway)
		return
	}
	// Keep an automatic recovery point before any restore mutation. If the
	// snapshot cannot be persisted, stop before touching League settings.
	preRestoreName := "Before restoring " + backup.Name
	if runes := []rune(preRestoreName); len(runes) > 48 {
		preRestoreName = string(runes[:48])
	}
	preRestore := featurestore.ClientSettingsBackup{
		ID:         "backup-pre-restore-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Name:       preRestoreName,
		AccountKey: accountKey,
		CreatedAt:  time.Now().UTC(),
		Payload:    mustJSON(settingsBackupPayload{General: currentGeneral, Input: currentInput}),
	}
	if err := store.Update(func(data *featurestore.Data) error {
		backups := append(data.SettingsBackups[accountKey], preRestore)
		if len(backups) > 10 {
			backups = backups[len(backups)-10:]
		}
		data.SettingsBackups[accountKey] = backups
		return nil
	}); err != nil {
		httpError(w, "Could not create the pre-restore snapshot; no settings were changed", http.StatusInternalServerError)
		return
	}
	if err := lf.PatchGameSettings(r.Context(), payload.General); err != nil {
		httpError(w, "Could not restore general League settings", http.StatusBadGateway)
		return
	}
	if err := lf.PatchInputSettings(r.Context(), payload.Input); err != nil {
		_ = lf.PatchGameSettings(r.Context(), currentGeneral)
		_ = lf.PatchInputSettings(r.Context(), currentInput)
		httpError(w, "Could not restore input settings; previous settings were restored", http.StatusBadGateway)
		return
	}
	if err := lf.SaveGameSettings(r.Context()); err != nil {
		_ = lf.PatchGameSettings(r.Context(), currentGeneral)
		_ = lf.PatchInputSettings(r.Context(), currentInput)
		httpError(w, "Could not save restored settings; previous settings were restored", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func mustJSON(value any) json.RawMessage { encoded, _ := json.Marshal(value); return encoded }

func containsInt(values []int, wanted int) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// openExternalProfileURL is kept server-side so the frontend can only receive
// links for an explicitly entered Riot ID and an allowlisted provider.
func openExternalProfileURL(provider, region, gameName, tagLine string) (string, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider != "opgg" && provider != "u.gg" && provider != "poro" && provider != "aramgg" {
		return "", fmt.Errorf("unsupported profile provider")
	}
	if strings.TrimSpace(gameName) == "" || strings.TrimSpace(tagLine) == "" || strings.TrimSpace(region) == "" {
		return "", fmt.Errorf("region and Riot ID are required")
	}
	name := url.PathEscape(strings.TrimSpace(gameName))
	tag := url.PathEscape(strings.TrimSpace(tagLine))
	switch provider {
	case "opgg":
		return "https://op.gg/lol/summoners/" + url.PathEscape(strings.ToLower(region)) + "/" + name + "-" + tag, nil
	case "u.gg":
		return "https://u.gg/lol/profile/" + url.PathEscape(strings.ToLower(region)) + "/" + name + "-" + tag, nil
	case "poro":
		return "https://poro.gg/summoner/" + url.PathEscape(strings.ToLower(region)) + "/" + name + "-" + tag, nil
	default:
		return "https://www.aramgg.com/summoner/" + url.PathEscape(strings.ToLower(region)) + "/" + name + "-" + tag, nil
	}
}
