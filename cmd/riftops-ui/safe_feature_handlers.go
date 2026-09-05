package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"sort"
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

// summarizeFieldResults keeps mutation responses honest. A request may have
// applied some fields and skipped or deferred others; callers must not infer
// full success from an unconditional {"ok":true} envelope.
func summarizeFieldResults(results map[string]string) (ok, partial bool) {
	hasIssue, hasSuccess := false, false
	for _, status := range results {
		value := strings.ToLower(strings.TrimSpace(status))
		switch {
		case strings.HasPrefix(value, "failed"), strings.HasPrefix(value, "skipped"), strings.HasPrefix(value, "unavailable"), strings.HasPrefix(value, "waiting"):
			hasIssue = true
		case strings.HasPrefix(value, "applied"), strings.HasPrefix(value, "created"):
			hasSuccess = true
		}
	}
	return !hasIssue, hasIssue && hasSuccess
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
	Warnings       []string        `json:"warnings,omitempty"`
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
	friends = bytesTrimSpace(friends)
	if err != nil || !isJSONObjectOrArray(friends) {
		httpError(w, "Could not load League friends", http.StatusServiceUnavailable)
		return
	}
	result := safeSocialResponse{Friends: friends, FetchedAt: time.Now().UTC()}
	if requests, requestErr := lf.FetchFriendRequests(ctx); requestErr == nil && isJSONObjectOrArray(requests) {
		result.FriendRequests = requests
	} else {
		// Keep an unavailable endpoint distinct from an empty list. Returning []
		// here would make a route change look like "no pending requests".
		result.Warnings = append(result.Warnings, "Friend requests are unavailable for this League patch")
	}
	if groups, groupsErr := lf.FetchFriendGroups(ctx); groupsErr == nil && isJSONObjectOrArray(groups) {
		result.FriendGroups = groups
	} else {
		result.Warnings = append(result.Warnings, "Friend folders are unavailable for this League patch")
	}
	if lobby, lobbyErr := lf.FetchCurrentLobby(ctx); lobbyErr == nil && isJSONObjectOrArray(lobby) {
		result.Lobby = lobby
	} else {
		var lcuErr *riotclient.LCUError
		// A 404 from the lobby endpoint is the normal idle state, not a
		// capability failure. Keep the membership set empty without showing a
		// warning on every social refresh.
		if errors.As(lobbyErr, &lcuErr) && lcuErr.StatusCode == http.StatusNotFound {
			result.Lobby = json.RawMessage(`{}`)
		} else {
			result.Warnings = append(result.Warnings, "Lobby membership is unavailable for this League patch")
		}
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
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	patch := fetchGameVersionLabel(ctx, lf)
	statuses := make([]map[string]string, 0, 12)
	appendStatus := func(id, status, detail string) {
		entry := map[string]string{"id": id, "status": status, "patch": patch}
		if detail != "" {
			entry["detail"] = detail
		}
		statuses = append(statuses, entry)
	}
	if _, err := lf.GetGameflowPhase(ctx); err == nil {
		appendStatus("gameflow", "supported", "")
	} else {
		appendStatus("gameflow", "unavailable", "Unavailable for this League patch")
	}
	probes := []struct {
		id    string
		shape byte
		probe func(context.Context) ([]byte, error)
	}{
		{id: "social", shape: '[', probe: lf.FetchLCUFriends},
		{id: "profile-icons", shape: '[', probe: func(ctx context.Context) ([]byte, error) {
			return lf.DoRequest(ctx, http.MethodGet, "/lol-game-data/assets/v1/summoner-icons.json")
		}},
		{id: "profile-regalia", shape: '{', probe: lf.FetchProfileRegalia},
		{id: "challenge-profile", shape: '{', probe: lf.FetchChallengeSummary},
		{id: "available-queues", shape: '[', probe: lf.FetchAvailableQueues},
		{id: "custom-bots", shape: 0, probe: lf.FetchCustomBots},
		{id: "arena-augments", shape: '[', probe: lf.FetchArenaAugments},
		{id: "game-settings", shape: '{', probe: lf.FetchGameSettings},
		{id: "input-settings", shape: '{', probe: lf.FetchInputSettings},
		{id: "pending-rewards", shape: 0, probe: lf.FetchPendingRewards},
	}
	for _, capability := range probes {
		raw, err := capability.probe(ctx)
		if err != nil {
			var lcuErr *riotclient.LCUError
			detail := "Unavailable for this League patch"
			if errors.As(err, &lcuErr) && lcuErr.StatusCode != http.StatusNotFound && lcuErr.StatusCode != http.StatusMethodNotAllowed {
				detail = "League Client did not make this capability available"
			}
			appendStatus(capability.id, "unavailable", detail)
			continue
		}
		trimmed := bytesTrimSpace(raw)
		if len(trimmed) == 0 || !json.Valid(trimmed) || (capability.shape != 0 && trimmed[0] != capability.shape) {
			appendStatus(capability.id, "changed", "League returned an unexpected response shape")
			continue
		}
		appendStatus(capability.id, "supported", "")
	}
	writeSafeJSON(w, statuses)
}

// fetchGameVersionLabel normalizes the two response shapes used by League's
// patch endpoint. Unknown object shapes stay explicitly unknown instead of
// leaking a serialized JSON object into the UI's patch badge.
func fetchGameVersionLabel(ctx context.Context, lf *riotclient.Lockfile) string {
	raw, err := lf.FetchGameVersion(ctx)
	if err != nil {
		return "unknown"
	}
	return normalizeGameVersionLabel(raw)
}

func normalizeGameVersionLabel(raw []byte) string {
	var value any
	if json.Unmarshal(raw, &value) == nil {
		switch typed := value.(type) {
		case string:
			if patch := strings.TrimSpace(typed); patch != "" {
				return patch
			}
		case map[string]any:
			for _, key := range []string{"gameVersion", "patchline", "version"} {
				if patch := strings.TrimSpace(fmt.Sprint(typed[key])); patch != "" && patch != "<nil>" {
					return patch
				}
			}
		}
	}
	return "unknown"
}

func bytesTrimSpace(value []byte) []byte {
	return []byte(strings.TrimSpace(string(value)))
}

func isJSONObjectOrArray(value []byte) bool {
	trimmed := bytesTrimSpace(value)
	return len(trimmed) > 0 && json.Valid(trimmed) && (trimmed[0] == '[' || trimmed[0] == '{')
}

func isJSONArray(value []byte) bool {
	trimmed := bytesTrimSpace(value)
	return len(trimmed) > 0 && json.Valid(trimmed) && trimmed[0] == '['
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
		parsed, err := strconv.ParseInt(id, 10, 64)
		if err != nil || parsed <= 0 {
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
	if preset.IconID < 0 || preset.BackgroundSkinID < 0 || preset.TitleID < 0 || preset.BannerID < 0 || len(preset.TokenIDs) > 3 || preset.SelectedPrestigeCrest < 0 || len(preset.BannerAccent) > 80 || len(preset.PreferredBannerType) > 80 || len(preset.PreferredCrestType) > 80 {
		httpError(w, "Preset asset ids are invalid", http.StatusBadRequest)
		return
	}
	for _, tokenID := range preset.TokenIDs {
		if tokenID <= 0 {
			httpError(w, "Challenge token ids must be positive", http.StatusBadRequest)
			return
		}
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
		ID        string `json:"id"`
		PreviewID string `json:"previewId"`
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
	if !consumePresetPreview(strings.TrimSpace(body.PreviewID), "profile", selected.ID, accountKey) {
		httpError(w, "Preview this preset again before applying it", http.StatusConflict)
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
	for field, status := range applyOwnedProfileRegalia(r.Context(), lf, *selected) {
		result[field] = status
	}
	ok, partial := summarizeFieldResults(result)
	writeSafeJSON(w, map[string]any{"ok": ok, "partial": partial, "preset": selected, "results": result})
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
	if regalia, regaliaErr := loadProfileRegaliaInventory(r.Context(), lf); regaliaErr == nil {
		currentView["regalia"] = regalia.Current
	}
	grant := newPresetPreview("profile", proposed.ID, accountKey)
	writeSafeJSON(w, map[string]any{"previewId": grant.ID, "expiresAt": grant.ExpiresAt, "current": currentView, "proposed": proposed, "requiresConfirmation": true})
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
	// Bot mutations are valid only while the current custom lobby is open.
	// Requiring the phase here prevents a stale phone/desktop request from
	// reaching the LCU after the lobby has advanced or ended.
	if !requireLCUPhase(w, r, lf, "Lobby") {
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
	if metadataErr != nil || inventoryErr != nil || !isJSONArray(metadata) {
		httpError(w, "Profile customization is unavailable for this League patch", http.StatusServiceUnavailable)
		return
	}
	writeSafeJSON(w, map[string]any{"icons": json.RawMessage(metadata), "ownedIconIds": inventory.IconIDs, "ownershipComplete": inventory.Complete})
}

func lcuProfileRegaliaHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	if r.Method == http.MethodGet {
		inventory, err := loadProfileRegaliaInventory(r.Context(), lf)
		if err != nil {
			httpError(w, "Profile regalia is unavailable for this League patch", http.StatusServiceUnavailable)
			return
		}
		writeSafeJSON(w, inventory)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request featurestore.ProfilePreset
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		httpError(w, "Invalid profile-regalia selection", http.StatusBadRequest)
		return
	}
	results := applyOwnedProfileRegalia(r.Context(), lf, request)
	if len(results) == 0 {
		httpError(w, "Select an owned title, token, banner, or crest", http.StatusBadRequest)
		return
	}
	ok, partial := summarizeFieldResults(results)
	writeSafeJSON(w, map[string]any{"ok": ok, "partial": partial, "results": results})
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
	if !requireLCUPhase(w, r, lf, "ChampSelect") {
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
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	augments, augmentErr := lf.FetchArenaAugments(r.Context())
	trimmedAugments := bytesTrimSpace(augments)
	if augmentErr != nil || len(trimmedAugments) == 0 || !json.Valid(trimmedAugments) || trimmedAugments[0] != '[' {
		httpError(w, "Arena augment catalogue is unavailable for this League patch", http.StatusServiceUnavailable)
		return
	}
	patch := fetchGameVersionLabel(r.Context(), lf)
	writeSafeJSON(w, map[string]any{
		"patch": patch, "arenaAugments": json.RawMessage(trimmedAugments),
		"arenaStatus": "supported", "aramBalance": []any{},
		"aramStatus": "unavailable", "aramDetail": "League does not expose an owned local ARAM balance catalogue on this patch",
	})
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
			writeSafeJSON(w, replayStatusResponse{GameID: func() int64 { value, _ := strconv.ParseInt(gameID, 10, 64); return value }(), Status: "unavailable", Error: "Replay is unavailable or expired"})
			return
		}
		status, _ := normalizeReplayMetadata(gameID, body)
		writeSafeJSON(w, status)
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
			metadata, metadataErr := lf.FetchReplayMetadata(r.Context(), gameID)
			status, valid := normalizeReplayMetadata(gameID, metadata)
			if metadataErr != nil || !valid || status.Status != "ready" {
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
	pending, pendingErr := lf.FetchPendingRewards(r.Context())
	if pendingErr != nil || !rewardSelectionPresent(pending, body.GrantID, body.RewardGroupID, body.Selections) {
		httpError(w, "Reward selection is no longer available", http.StatusConflict)
		return
	}
	if err := lf.SelectReward(r.Context(), body.GrantID, body.RewardGroupID, body.Selections); err != nil {
		httpError(w, "League rejected the reward selection", http.StatusBadGateway)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func rewardSelectionPresent(body []byte, grantID, groupID string, selections []string) bool {
	grantID, groupID = strings.TrimSpace(grantID), strings.TrimSpace(groupID)
	if grantID == "" || groupID == "" || len(selections) == 0 || !json.Valid(body) {
		return false
	}
	wanted := make(map[string]bool, len(selections))
	for _, selection := range selections {
		selection = strings.TrimSpace(selection)
		if selection == "" {
			return false
		}
		wanted[selection] = false
	}
	var root any
	if json.Unmarshal(body, &root) != nil {
		return false
	}
	var visit func(any, string, string)
	visit = func(value any, inheritedGrant, inheritedGroup string) {
		switch current := value.(type) {
		case []any:
			for _, child := range current {
				visit(child, inheritedGrant, inheritedGroup)
			}
		case map[string]any:
			localGrant, localGroup := inheritedGrant, inheritedGroup
			for _, key := range []string{"grantId", "grantID"} {
				if candidate := strings.TrimSpace(fmt.Sprint(current[key])); candidate != "" && candidate != "<nil>" {
					localGrant = candidate
				}
			}
			for _, key := range []string{"rewardGroupId", "rewardGroupID", "groupId", "groupID"} {
				if candidate := strings.TrimSpace(fmt.Sprint(current[key])); candidate != "" && candidate != "<nil>" {
					localGroup = candidate
				}
			}
			if localGrant == "" {
				if _, hasGroups := current["rewardGroups"]; hasGroups {
					if candidate := strings.TrimSpace(fmt.Sprint(current["id"])); candidate != "" && candidate != "<nil>" {
						localGrant = candidate
					}
				}
			}
			if localGrant == grantID && localGroup == groupID {
				for _, key := range []string{"id", "rewardId", "rewardID", "itemId", "itemID"} {
					candidate := strings.TrimSpace(fmt.Sprint(current[key]))
					if _, ok := wanted[candidate]; ok {
						wanted[candidate] = true
					}
				}
			}
			for _, child := range current {
				visit(child, localGrant, localGroup)
			}
		}
	}
	visit(root, "", "")
	for _, found := range wanted {
		if !found {
			return false
		}
	}
	return true
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
		ID        string `json:"id"`
		PreviewID string `json:"previewId"`
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
	if !consumePresetPreview(strings.TrimSpace(body.PreviewID), "preparation", selected.ID, accountKey) {
		httpError(w, "Preview this preset again before applying it", http.StatusConflict)
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
	ok, partial := summarizeFieldResults(result)
	writeSafeJSON(w, map[string]any{"ok": ok, "partial": partial, "preset": selected, "results": result})
}

func preparationPresetPreviewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	lf := safeLCU(w)
	if store == nil || lf == nil {
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
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.ID) == "" {
		httpError(w, "Preset id is required", http.StatusBadRequest)
		return
	}
	var selected *featurestore.PreparationPreset
	for _, preset := range store.Snapshot().PreparationPresets[accountKey] {
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
	phase, _ := lf.GetGameflowPhase(r.Context())
	grant := newPresetPreview("preparation", selected.ID, accountKey)
	writeSafeJSON(w, map[string]any{
		"previewId": grant.ID, "expiresAt": grant.ExpiresAt, "proposed": selected,
		"current": map[string]any{"gameflowPhase": phase}, "requiresConfirmation": true,
	})
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
	lf := safeLCU(w)
	if lf == nil {
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
	queue, queueErr := findAvailableQueue(r.Context(), lf, preset.QueueID)
	if queueErr != nil {
		httpError(w, "That queue is unavailable for this League patch", http.StatusConflict)
		return
	}
	preset.QueueName, preset.GameMode, preset.MapID = queue.Name, queue.GameMode, queue.MapID
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
		ID        string `json:"id"`
		PreviewID string `json:"previewId"`
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
	if !consumePresetPreview(strings.TrimSpace(body.PreviewID), "lobby", selected.ID, "") {
		httpError(w, "Preview this preset again before applying it", http.StatusConflict)
		return
	}
	queue, queueErr := findAvailableQueue(r.Context(), lf, selected.QueueID)
	if queueErr != nil {
		httpError(w, "That queue is unavailable for this League patch", http.StatusConflict)
		return
	}
	if err := createAvailableQueueLobby(r.Context(), lf, queue); err != nil {
		httpError(w, "League rejected the lobby preset", http.StatusBadGateway)
		return
	}
	results := map[string]string{"lobby": "created"}
	if selected.FirstRole != "" && selected.SecondRole != "" {
		if err := lf.AutoSetRoles(r.Context(), selected.FirstRole, selected.SecondRole); err != nil {
			results["rolePreferences"] = "unavailable for this queue or League patch"
		} else {
			results["rolePreferences"] = "applied"
		}
	}
	ok, partial := summarizeFieldResults(results)
	writeSafeJSON(w, map[string]any{"ok": ok, "partial": partial, "preset": selected, "results": results})
}

func lobbyPresetPreviewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	lf := safeLCU(w)
	if store == nil || lf == nil {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.ID) == "" {
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
	queue, err := findAvailableQueue(r.Context(), lf, selected.QueueID)
	if err != nil {
		httpError(w, "That queue is unavailable for this League patch", http.StatusConflict)
		return
	}
	current := json.RawMessage(`null`)
	if lobby, lobbyErr := lf.FetchCurrentLobby(r.Context()); lobbyErr == nil && json.Valid(lobby) {
		current = lobby
	}
	proposed := *selected
	proposed.QueueName, proposed.GameMode, proposed.MapID = queue.Name, queue.GameMode, queue.MapID
	grant := newPresetPreview("lobby", selected.ID, "")
	writeSafeJSON(w, map[string]any{"previewId": grant.ID, "expiresAt": grant.ExpiresAt, "current": current, "proposed": proposed, "requiresConfirmation": true})
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
		RollbackID  string                `json:"rollbackId"`
		Name        string                `json:"name"`
		ChampionIDs []string              `json:"championIds"`
		Mode        string                `json:"mode"`
		Map         string                `json:"map"`
		Blocks      []managedItemSetBlock `json:"blocks"`
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
	current, err := lf.FetchItemSets(r.Context(), summoner.SummonerID)
	if err != nil {
		httpError(w, "League item sets are unavailable", http.StatusBadGateway)
		return
	}
	encoded, managed, mergeErr := mergeManagedItemSet(current, managedItemSetSpec{Name: request.Name, ChampionIDs: request.ChampionIDs, Mode: request.Mode, Map: request.Map, Blocks: request.Blocks})
	if mergeErr != nil {
		httpError(w, mergeErr.Error(), http.StatusBadRequest)
		return
	}
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
	var proposed settingsBackupPayload
	if json.Unmarshal(backup.Payload, &proposed) != nil {
		httpError(w, "Settings backup is invalid", http.StatusBadGateway)
		return
	}
	changes := append(settingsDiffPaths("game", currentGeneral, proposed.General), settingsDiffPaths("input", currentInput, proposed.Input)...)
	sort.Strings(changes)
	changeCount := len(changes)
	if len(changes) > 200 {
		changes = changes[:200]
	}
	redactedBackup := *backup
	redactedBackup.Payload = nil
	writeSafeJSON(w, map[string]any{"backup": redactedBackup, "changes": changes, "changeCount": changeCount, "restoreConfirmation": "RESTORE SETTINGS"})
}

func settingsDiffPaths(prefix string, currentBody, proposedBody []byte) []string {
	var current, proposed any
	if json.Unmarshal(currentBody, &current) != nil || json.Unmarshal(proposedBody, &proposed) != nil {
		return []string{prefix}
	}
	result := make([]string, 0)
	var compare func(string, any, any)
	compare = func(path string, left, right any) {
		leftMap, leftOK := left.(map[string]any)
		rightMap, rightOK := right.(map[string]any)
		if leftOK && rightOK {
			keys := make(map[string]struct{}, len(leftMap)+len(rightMap))
			for key := range leftMap {
				keys[key] = struct{}{}
			}
			for key := range rightMap {
				keys[key] = struct{}{}
			}
			for key := range keys {
				next := key
				if path != "" {
					next = path + "." + key
				}
				compare(next, leftMap[key], rightMap[key])
			}
			return
		}
		if !reflect.DeepEqual(left, right) {
			result = append(result, path)
		}
	}
	compare(prefix, current, proposed)
	return result
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
	rollback := func() error {
		if rollbackErr := lf.PatchGameSettings(r.Context(), currentGeneral); rollbackErr != nil {
			return rollbackErr
		}
		return lf.PatchInputSettings(r.Context(), currentInput)
	}
	if err := lf.PatchGameSettings(r.Context(), payload.General); err != nil {
		if rollbackErr := rollback(); rollbackErr != nil {
			httpError(w, "Could not restore general League settings; the previous settings could not be confirmed", http.StatusBadGateway)
		} else {
			httpError(w, "Could not restore general League settings; previous settings were restored", http.StatusBadGateway)
		}
		return
	}
	if err := lf.PatchInputSettings(r.Context(), payload.Input); err != nil {
		if rollbackErr := rollback(); rollbackErr != nil {
			httpError(w, "Could not restore input settings; the previous settings could not be confirmed", http.StatusBadGateway)
		} else {
			httpError(w, "Could not restore input settings; previous settings were restored", http.StatusBadGateway)
		}
		return
	}
	if err := lf.SaveGameSettings(r.Context()); err != nil {
		if rollbackErr := rollback(); rollbackErr != nil {
			httpError(w, "Could not save restored settings; the previous settings could not be confirmed", http.StatusBadGateway)
		} else {
			httpError(w, "Could not save restored settings; previous settings were restored", http.StatusBadGateway)
		}
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
