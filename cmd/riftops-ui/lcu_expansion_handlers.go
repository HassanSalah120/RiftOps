package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

func expansionContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 5*time.Second)
}

func writeExpansionError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	var lcuErr *riotclient.LCUError
	if errors.As(err, &lcuErr) {
		switch lcuErr.StatusCode {
		case http.StatusNotFound, http.StatusMethodNotAllowed:
			httpError(w, "This League capability is unavailable for the current patch", http.StatusNotImplemented)
		case http.StatusBadRequest, http.StatusConflict:
			httpError(w, "League rejected the current action or state", http.StatusConflict)
		case http.StatusUnauthorized, http.StatusForbidden:
			httpError(w, "League did not permit this action", http.StatusForbidden)
		case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			httpError(w, "League returned an upstream error", http.StatusBadGateway)
		default:
			httpError(w, "League request failed", http.StatusBadGateway)
		}
		return
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "required") || strings.Contains(message, "invalid") || strings.Contains(message, "unsupported") {
		httpError(w, "The RiftOps request is invalid", http.StatusBadRequest)
		return
	}
	httpError(w, "League returned an unexpected response", http.StatusBadGateway)
}

func expansionMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func desktopExpansion(w http.ResponseWriter, r *http.Request) bool {
	if remoteRequest(r) {
		httpError(w, "This League action is desktop-only", http.StatusForbidden)
		return false
	}
	return true
}

type champSelectChampionSwapRequest struct {
	ID     int64  `json:"id"`
	Action string `json:"action"`
}

func lcuChampSelectChampionSwapsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	switch r.Method {
	case http.MethodGet:
		swaps, err := lf.FetchChampSelectChampionSwaps(ctx)
		if err != nil {
			writeExpansionError(w, err)
			return
		}
		writeSafeJSON(w, swaps)
	case http.MethodPost:
		if !desktopExpansion(w, r) {
			return
		}
		var body champSelectChampionSwapRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpError(w, "Invalid champion swap request", http.StatusBadRequest)
			return
		}
		if body.ID < 0 {
			httpError(w, "Champion swap id is invalid", http.StatusBadRequest)
			return
		}
		result, err := lf.UpdateChampSelectChampionSwap(ctx, body.ID, strings.ToLower(strings.TrimSpace(body.Action)))
		if err != nil {
			writeExpansionError(w, err)
			return
		}
		if result.ID == 0 {
			writeSafeJSON(w, map[string]any{"ok": true})
			return
		}
		writeSafeJSON(w, result)
	default:
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func lcuOngoingChampSelectSwapsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	swaps, err := lf.FetchOngoingChampSelectSwaps(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	normalized := map[string]any{"champion": nil, "pickOrder": nil, "position": nil}
	for kind, swap := range swaps {
		if swap == nil {
			continue
		}
		normalized[kind] = map[string]any{
			"id": swap.ID, "kind": kind, "state": swap.State, "initiatedByLocalPlayer": swap.InitiatedByLocalPlayer,
			"requesterIndex": swap.RequesterIndex, "responderIndex": swap.ResponderIndex, "otherSummonerIndex": swap.OtherSummonerIndex,
			"requesterChampionId": swap.RequesterChampionID, "requesterChampionName": swap.RequesterChampionName,
			"requesterPosition": swap.RequesterPosition, "responderPosition": swap.ResponderPosition,
		}
	}
	writeSafeJSON(w, normalized)
}

func lcuOngoingChampSelectSwapClearHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		Kind string `json:"kind"`
		ID   int64  `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid ongoing swap request", http.StatusBadRequest)
		return
	}
	if body.ID < 0 {
		httpError(w, "Ongoing swap id is invalid", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.ClearOngoingChampSelectSwap(ctx, strings.TrimSpace(body.Kind), body.ID); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

type normalizedReadyCheck struct {
	State          string `json:"state"`
	PlayerResponse string `json:"playerResponse"`
	TimerSeconds   int64  `json:"timerSeconds"`
}

func normalizeReadyCheck(raw json.RawMessage) *normalizedReadyCheck {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value struct {
		State          string `json:"state"`
		PlayerResponse string `json:"playerResponse"`
		Timer          int64  `json:"timer"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return &normalizedReadyCheck{State: value.State, PlayerResponse: value.PlayerResponse, TimerSeconds: value.Timer}
}

func lcuMatchmakingStatusHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	diagnostics, errorsList, err := lf.FetchMatchmakingDiagnostics(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	errorsOut := make([]map[string]any, 0, len(errorsList))
	for _, item := range errorsList {
		errorsOut = append(errorsOut, map[string]any{
			"id": item.ID, "type": item.ErrorType, "message": item.Message,
			"penalizedSummonerId": nullableInt64(item.PenalizedSummonerID),
			"penaltySeconds":      item.PenaltyTimeRemaining,
		})
	}
	var lowPriority any
	if diagnostics.LowPriorityData != nil {
		lowPriority = map[string]any{
			"penalizedSummonerIds": diagnostics.LowPriorityData.PenalizedSummonerIDs,
			"penaltySeconds":       diagnostics.LowPriorityData.PenaltyTimeRemaining,
			"reason":               diagnostics.LowPriorityData.Reason,
		}
	}
	writeSafeJSON(w, map[string]any{
		"queueId":          diagnostics.QueueID,
		"inQueue":          diagnostics.IsCurrentlyInQueue,
		"state":            diagnostics.SearchState,
		"elapsedSeconds":   diagnostics.TimeInQueue,
		"estimatedSeconds": diagnostics.EstimatedQueueTime,
		"readyCheck":       normalizeReadyCheck(diagnostics.ReadyCheck),
		"errors":           errorsOut,
		"lowPriority":      lowPriority,
	})
}

func nullableInt64(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}

func lcuLeaverBusterHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	notifications, ranked, err := lf.FetchLeaverBusterStatus(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(notifications))
	for _, item := range notifications {
		items = append(items, map[string]any{
			"id": item.ID, "type": item.Type, "punishedGamesRemaining": item.PunishedGamesRemaining,
			"lockoutRemainingMs": item.QueueLockoutTimerExpiryMillisDiff,
		})
	}
	writeSafeJSON(w, map[string]any{"notifications": items, "ranked": ranked})
}

func lcuLeaverDismissHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid restriction notification", http.StatusBadRequest)
		return
	}
	if body.ID <= 0 {
		httpError(w, "Restriction notification id is invalid", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.DismissLeaverNotification(ctx, body.ID); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func containsJSONString(value any, needle string) bool {
	switch typed := value.(type) {
	case string:
		return typed == needle
	case []any:
		for _, child := range typed {
			if containsJSONString(child, needle) {
				return true
			}
		}
	case map[string]any:
		for _, child := range typed {
			if containsJSONString(child, needle) {
				return true
			}
		}
	}
	return false
}

func cleanFriendPuuids(values []string, max int) ([]string, error) {
	if len(values) == 0 || len(values) > max {
		return nil, fmt.Errorf("select between 1 and %d friends", max)
	}
	seen := make(map[string]struct{}, len(values))
	clean := make([]string, 0, len(values))
	for _, raw := range values {
		puuid := strings.TrimSpace(raw)
		if puuid == "" || len(puuid) > 160 {
			return nil, fmt.Errorf("friend PUUID is invalid")
		}
		if _, exists := seen[puuid]; exists {
			continue
		}
		seen[puuid] = struct{}{}
		clean = append(clean, puuid)
	}
	if len(clean) == 0 {
		return nil, fmt.Errorf("select at least one friend")
	}
	return clean, nil
}

func validateFriendPuuids(ctx context.Context, lf *riotclient.Lockfile, puuids []string) error {
	friends, err := lf.FetchLCUFriends(ctx)
	if err != nil {
		return err
	}
	var friendValue any
	if json.Unmarshal(friends, &friendValue) != nil {
		return fmt.Errorf("friend list changed")
	}
	for _, puuid := range puuids {
		if !containsJSONString(friendValue, puuid) {
			return fmt.Errorf("selected friend is no longer present")
		}
	}
	return nil
}

func lcuSpectatorConfigHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	config, err := lf.FetchSpectatorConfig(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, config)
}

func lcuSpectatorLaunchHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		PUUID string `json:"puuid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "A friend PUUID is required", http.StatusBadRequest)
		return
	}
	body.PUUID = strings.TrimSpace(body.PUUID)
	if body.PUUID == "" || len(body.PUUID) > 160 {
		httpError(w, "A friend PUUID is required", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := validateFriendPuuids(ctx, lf, []string{body.PUUID}); err != nil {
		var lcuErr *riotclient.LCUError
		if errors.As(err, &lcuErr) {
			writeExpansionError(w, err)
			return
		}
		httpError(w, "The selected friend is not available for spectating", http.StatusConflict)
		return
	}
	available, err := lf.PrepareSpectator(ctx, []string{body.PUUID})
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	if len(available) == 0 {
		writeSafeJSON(w, map[string]any{"available": false, "launched": false, "reason": "Friend is not currently spectatable"})
		return
	}
	info, err := lf.FetchSpectateGameInfo(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	canWatch, err := lf.CheckCanSpectate(ctx, info.PUUID, info.SpectatorKey)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	if !canWatch.AvailableForWatching {
		writeSafeJSON(w, map[string]any{"available": false, "launched": false, "reason": canWatch.Reason})
		return
	}
	if err := lf.LaunchSpectator(ctx, info); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]any{"available": true, "launched": true, "queueType": info.GameQueueType})
}

type customGamesResponse struct {
	Availability string           `json:"availability"`
	CountdownMs  int64            `json:"countdownMs"`
	Games        []map[string]any `json:"games"`
	Invitations  []map[string]any `json:"invitations"`
	Warnings     []string         `json:"warnings,omitempty"`
}

func fetchCustomGamesResponse(ctx context.Context, lf *riotclient.Lockfile) (customGamesResponse, error) {
	games, err := lf.FetchCustomGames(ctx)
	if err != nil {
		return customGamesResponse{}, err
	}
	result := customGamesResponse{Games: make([]map[string]any, 0, len(games)), Invitations: []map[string]any{}}
	for _, game := range games {
		result.Games = append(result.Games, map[string]any{
			"id": game.ID, "name": game.LobbyName, "owner": game.OwnerDisplayName, "gameType": game.GameType,
			"mapId": game.MapID, "passwordRequired": game.HasPassword,
			"players":         map[string]int{"filled": game.FilledPlayerSlots, "maximum": game.MaxPlayerSlots},
			"spectators":      map[string]int{"filled": game.FilledSpectatorSlots, "maximum": game.MaxSpectatorSlots},
			"spectatorPolicy": game.SpectatorPolicy,
		})
	}
	if availability, availabilityErr := lf.FetchLobbyAvailability(ctx); availabilityErr == nil {
		result.Availability = availability
	} else {
		result.Warnings = append(result.Warnings, "Custom-lobby availability is unavailable")
	}
	if countdown, countdownErr := lf.FetchLobbyCountdown(ctx); countdownErr == nil {
		result.CountdownMs = countdown
	}
	if invitations, invitationErr := lf.FetchReceivedInvitations(ctx); invitationErr == nil {
		for _, invitation := range invitations {
			restrictions := make([]string, 0, len(invitation.Restrictions))
			for _, rawRestriction := range invitation.Restrictions {
				var label string
				if json.Unmarshal(rawRestriction, &label) == nil && strings.TrimSpace(label) != "" {
					restrictions = append(restrictions, strings.TrimSpace(label))
				} else {
					restrictions = append(restrictions, "League restriction")
				}
			}
			result.Invitations = append(result.Invitations, map[string]any{
				"id": invitation.InvitationID, "type": invitation.InvitationType,
				"senderPuuid": invitation.FromPUUID, "senderName": invitation.FromSummonerName,
				"canAccept": invitation.CanAcceptInvitation, "restrictions": restrictions,
				"state": invitation.State, "receivedAt": invitation.Timestamp,
			})
		}
	} else {
		result.Warnings = append(result.Warnings, "Received custom-lobby invitations are unavailable")
	}
	return result, nil
}

func lcuCustomGamesHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	result, err := fetchCustomGamesResponse(ctx, lf)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, result)
}

func lcuCustomGamesRefreshHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.RefreshCustomGames(ctx); err != nil {
		writeExpansionError(w, err)
		return
	}
	result, err := fetchCustomGamesResponse(ctx, lf)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, result)
}

func lcuLobbyInvitationActionHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		InvitationID string `json:"invitationId"`
		Action       string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid invitation action", http.StatusBadRequest)
		return
	}
	body.InvitationID = strings.TrimSpace(body.InvitationID)
	body.Action = strings.ToLower(strings.TrimSpace(body.Action))
	if body.Action != "decline" || body.InvitationID == "" || len(body.InvitationID) > 160 {
		httpError(w, "Only declining a current invitation is available directly", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	invitations, err := lf.FetchReceivedInvitations(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	found := false
	for _, invitation := range invitations {
		if invitation.InvitationID == body.InvitationID {
			found = true
			break
		}
	}
	if !found {
		httpError(w, "Invitation is no longer available", http.StatusConflict)
		return
	}
	if err := lf.ActOnReceivedInvitation(ctx, body.InvitationID, body.Action); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuCustomChampSelectCancelHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.CancelCustomChampSelect(ctx); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuChatPrivacyHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	mutes, err := lf.FetchChatMutes(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	settings, err := lf.FetchChatSettings(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	normalizedMutes := make([]map[string]any, 0, len(mutes))
	for _, mute := range mutes {
		normalizedMutes = append(normalizedMutes, map[string]any{"puuid": mute.PUUID, "playerMuted": mute.PlayerMuted, "settingsMuted": mute.SettingsMuted, "systemMuted": mute.SystemMuted})
	}
	writeSafeJSON(w, map[string]any{"mutes": normalizedMutes, "settings": sanitizeChatSettings(settings)})
}

func sanitizeChatSettings(settings riotclient.LCUChatSettings) map[string]any {
	allowed := []string{"friendRequestToastsDisabled", "linkClickWarningEnabled", "messageNotificationsEnabled", "showWhenTypingEnabled", "chatFilterDisabled"}
	result := make(map[string]any, len(allowed))
	for _, key := range allowed {
		result[key] = false
		if value, ok := settings[key]; ok {
			if typed, ok := value.(bool); ok {
				result[key] = typed
			}
		}
	}
	return result
}

func lcuChatMutesHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		PUUIDs []string `json:"puuids"`
		Muted  bool     `json:"muted"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid chat mute request", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	puuids, err := cleanFriendPuuids(body.PUUIDs, 100)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	if len(puuids) != 1 {
		httpError(w, "Multi-player chat mutes require a reviewed operation", http.StatusBadRequest)
		return
	}
	if err := validateFriendPuuids(ctx, lf, puuids); err != nil {
		var lcuErr *riotclient.LCUError
		if errors.As(err, &lcuErr) {
			writeExpansionError(w, err)
		} else {
			httpError(w, "A selected friend is no longer available", http.StatusConflict)
		}
		return
	}
	if err := lf.UpdateChatMutes(ctx, puuids, body.Muted); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]any{"ok": true, "updated": puuids})
}

func lcuChatSettingsHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid chat settings", http.StatusBadRequest)
		return
	}
	if len(body) == 0 {
		httpError(w, "At least one chat setting is required", http.StatusBadRequest)
		return
	}
	allowed := map[string]bool{"friendRequestToastsDisabled": true, "linkClickWarningEnabled": true, "messageNotificationsEnabled": true, "showWhenTypingEnabled": true, "chatFilterDisabled": true}
	settings := make(riotclient.LCUChatSettings)
	for key, value := range body {
		if !allowed[key] {
			httpError(w, "Unsupported chat setting", http.StatusBadRequest)
			return
		}
		if _, ok := value.(bool); !ok {
			httpError(w, "Chat setting must be boolean", http.StatusBadRequest)
			return
		}
		settings[key] = value
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if _, err := lf.UpdateChatSettings(ctx, settings); err != nil {
		writeExpansionError(w, err)
		return
	}
	latest, err := lf.FetchChatSettings(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, sanitizeChatSettings(latest))
}

func lcuMissionsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	missions, series, err := lf.FetchMissions(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	normalized := make([]map[string]any, 0, len(missions))
	for _, mission := range missions {
		objectives := make([]map[string]any, 0, len(mission.Objectives))
		for index, rawObjective := range mission.Objectives {
			objectives = append(objectives, normalizeMissionObjective(rawObjective, index))
		}
		rewards := make([]map[string]any, 0, len(mission.Rewards))
		for index, rawReward := range mission.Rewards {
			rewards = append(rewards, normalizeMissionReward(rawReward, index))
		}
		normalized = append(normalized, map[string]any{
			"id": mission.ID, "title": mission.Title, "description": mission.Description, "helperText": mission.HelperText,
			"status": mission.Status, "viewed": mission.Viewed, "startAt": mission.StartTime, "endAt": mission.EndTime,
			"seriesName": mission.SeriesName, "sequence": mission.Sequence, "objectives": objectives, "rewards": rewards,
		})
	}
	writeSafeJSON(w, map[string]any{"missions": normalized, "series": series, "refreshedAt": time.Now().UTC()})
}

func rawObject(raw json.RawMessage) map[string]any {
	var object map[string]any
	if json.Unmarshal(raw, &object) != nil {
		return map[string]any{}
	}
	return object
}

func rawString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := object[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func rawNumber(object map[string]any, keys ...string) float64 {
	for _, key := range keys {
		if value, ok := object[key].(float64); ok && value >= 0 {
			return value
		}
	}
	return 0
}

func rawBool(object map[string]any, keys ...string) bool {
	for _, key := range keys {
		if value, ok := object[key].(bool); ok {
			return value
		}
	}
	return false
}

func normalizeMissionObjective(raw json.RawMessage, index int) map[string]any {
	object := rawObject(raw)
	id := rawString(object, "id", "objectiveId", "key")
	if id == "" {
		id = fmt.Sprintf("objective-%d", index+1)
	}
	label := rawString(object, "label", "description", "title", "name")
	if label == "" {
		label = "Objective"
	}
	return map[string]any{
		"id": id, "label": label,
		"current": rawNumber(object, "current", "currentProgress", "progress", "value", "amount"),
		"goal":    rawNumber(object, "goal", "target", "total", "max"),
		"status":  rawString(object, "status", "state"),
	}
}

func normalizeMissionReward(raw json.RawMessage, index int) map[string]any {
	object := rawObject(raw)
	id := rawString(object, "id", "rewardId", "itemId")
	if id == "" {
		id = fmt.Sprintf("reward-%d", index+1)
	}
	return map[string]any{
		"groupId":   rawString(object, "groupId", "rewardGroupId"),
		"itemId":    rawString(object, "itemId", "contentId"),
		"type":      rawString(object, "type", "itemType", "rewardType"),
		"quantity":  rawNumber(object, "quantity", "count"),
		"fulfilled": rawBool(object, "fulfilled", "claimed"),
		"selected":  rawBool(object, "selected"),
		"id":        id,
	}
}

func lcuRewardsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	grants, err := lf.FetchRewardGrants(ctx, r.URL.Query().Get("status"))
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	normalized := make([]map[string]any, 0, len(grants))
	for _, grant := range grants {
		items := make([]map[string]any, 0, len(grant.RewardGroup.Rewards))
		for _, reward := range grant.RewardGroup.Rewards {
			items = append(items, map[string]any{"id": reward.ID, "itemId": reward.ItemID, "itemType": reward.ItemType, "quantity": reward.Quantity})
		}
		minimum, maximum := 0, 0
		if grant.RewardGroup.SelectionStrategyConfig != nil {
			minimum = grant.RewardGroup.SelectionStrategyConfig.MinSelectionsAllowed
			maximum = grant.RewardGroup.SelectionStrategyConfig.MaxSelectionsAllowed
		}
		normalized = append(normalized, map[string]any{
			"id": grant.Info.ID, "groupId": grant.Info.RewardGroupID, "status": grant.Info.Status,
			"createdAt": grant.Info.DateCreated, "viewed": grant.Info.Viewed, "selectedIds": grant.Info.SelectedIDs,
			"strategy": grant.RewardGroup.RewardStrategy, "minimumSelections": minimum, "maximumSelections": maximum,
			"rewards": items,
		})
	}
	writeSafeJSON(w, map[string]any{"grants": normalized})
}

func lcuRewardsViewedHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		GrantIDs []string `json:"grantIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid reward view request", http.StatusBadRequest)
		return
	}
	if len(body.GrantIDs) == 0 || len(body.GrantIDs) > 100 {
		httpError(w, "Select between 1 and 100 grants", http.StatusBadRequest)
		return
	}
	seenGrantIDs := make(map[string]struct{}, len(body.GrantIDs))
	for index, rawID := range body.GrantIDs {
		id := strings.TrimSpace(rawID)
		if id == "" || len(id) > 160 {
			httpError(w, "Reward grant id is invalid", http.StatusBadRequest)
			return
		}
		if _, exists := seenGrantIDs[id]; exists {
			httpError(w, "Reward grant ids must be unique", http.StatusBadRequest)
			return
		}
		seenGrantIDs[id] = struct{}{}
		body.GrantIDs[index] = id
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.MarkRewardsViewed(ctx, body.GrantIDs); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuRewardsReplayHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		RewardGroupID string `json:"rewardGroupId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid reward replay request", http.StatusBadRequest)
		return
	}
	body.RewardGroupID = strings.TrimSpace(body.RewardGroupID)
	if body.RewardGroupID == "" || len(body.RewardGroupID) > 160 {
		httpError(w, "Reward group id is invalid", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.ReplayRewardGroup(ctx, body.RewardGroupID); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuMasteryHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	champions, score, sets, notification, grants, err := lf.FetchMasteryProgress(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	var normalizedNotification any
	if notification != nil {
		normalizedNotification = map[string]any{
			"championId":   notification.ChampionID,
			"grade":        notification.Grade,
			"pointsGained": notification.Points,
			"won":          notification.Won,
		}
	}
	normalizedGrants := make([]map[string]any, 0, len(grants))
	for _, grant := range grants {
		normalizedGrants = append(normalizedGrants, map[string]any{"id": grant.ID, "championId": grant.ChampionID, "gameId": grant.GameID, "messageKey": grant.MessageKey, "grade": grant.PlayerGrade})
	}
	writeSafeJSON(w, map[string]any{"totalScore": score, "champions": champions, "milestones": json.RawMessage(sets), "notification": normalizedNotification, "rewardGrants": normalizedGrants})
}

func lcuMasteryAckHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.AcknowledgeMasteryNotification(ctx); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuMasteryGrantDismissHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid mastery grant", http.StatusBadRequest)
		return
	}
	body.ID = strings.TrimSpace(body.ID)
	if body.ID == "" || len(body.ID) > 160 {
		httpError(w, "Mastery grant id is invalid", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	if err := lf.DismissMasteryRewardGrant(ctx, body.ID); err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func lcuMasteryScoutingHandler(w http.ResponseWriter, r *http.Request) {
	if !desktopExpansion(w, r) || !expansionMethod(w, r, http.MethodPost) {
		return
	}
	lf := safeLCU(w)
	if lf == nil {
		return
	}
	var body struct {
		PUUIDs []string `json:"puuids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid mastery scouting request", http.StatusBadRequest)
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	puuids, err := cleanFriendPuuids(body.PUUIDs, 10)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	if err := validateFriendPuuids(ctx, lf, puuids); err != nil {
		var lcuErr *riotclient.LCUError
		if errors.As(err, &lcuErr) {
			writeExpansionError(w, err)
		} else {
			httpError(w, "A selected friend is no longer available", http.StatusConflict)
		}
		return
	}
	results, err := lf.ScoutMastery(ctx, puuids)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, results)
}

func lcuLoadoutsHandler(w http.ResponseWriter, r *http.Request) {
	lf := safeLCU(w)
	if lf == nil || !expansionMethod(w, r, http.MethodGet) {
		return
	}
	ctx, cancel := expansionContext(r)
	defer cancel()
	ready, err := lf.FetchLoadoutsReady(ctx)
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	scope := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("scope")))
	if scope == "" {
		scope = "account"
	}
	var loadouts []riotclient.LCULoadout
	if scope == "account" {
		loadouts, err = lf.FetchAccountLoadouts(ctx)
	} else {
		loadouts, err = lf.FetchScopedLoadouts(ctx, scope, r.URL.Query().Get("itemId"))
	}
	if err != nil {
		writeExpansionError(w, err)
		return
	}
	writeSafeJSON(w, map[string]any{"ready": ready, "items": loadouts})
}
