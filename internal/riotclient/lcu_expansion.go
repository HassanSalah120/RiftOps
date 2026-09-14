package riotclient

// This file contains typed wrappers for the additional LCU surfaces used by
// RiftOps.  These routes are client-internal, so callers must capability-gate
// them and treat 404/405 as a patch-level absence rather than a global error.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func decodeExpansionJSON(body []byte, target any) error {
	if len(body) == 0 {
		return fmt.Errorf("empty League response")
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode League response: %w", err)
	}
	return nil
}

func (lf *Lockfile) getExpansionJSON(ctx context.Context, path string, target any) error {
	body, err := lf.DoRequest(ctx, http.MethodGet, path)
	if err != nil {
		return err
	}
	return decodeExpansionJSON(body, target)
}

func (lf *Lockfile) postExpansionJSON(ctx context.Context, path string, payload any, target any) error {
	var body []byte
	var err error
	if payload == nil {
		body, err = lf.DoRequest(ctx, http.MethodPost, path)
	} else {
		body, err = lf.doJSON(ctx, http.MethodPost, path, payload)
	}
	if err != nil {
		return err
	}
	if target == nil || len(body) == 0 {
		return nil
	}
	return decodeExpansionJSON(body, target)
}

type LCUChampionSwap struct {
	CellID int64  `json:"cellId"`
	ID     int64  `json:"id"`
	State  string `json:"state"`
}

type LCUOngoingSwap struct {
	ID                      int64  `json:"id"`
	InitiatedByLocalPlayer  bool   `json:"initiatedByLocalPlayer"`
	OtherSummonerIndex      int    `json:"otherSummonerIndex"`
	RequesterChampionID     int    `json:"requesterChampionId,omitempty"`
	RequesterChampionName   string `json:"requesterChampionName,omitempty"`
	RequesterChampionSplash string `json:"requesterChampionSplashPath,omitempty"`
	ResponderChampionName   string `json:"responderChampionName,omitempty"`
	ResponderIndex          int    `json:"responderIndex,omitempty"`
	RequesterIndex          int    `json:"requesterIndex,omitempty"`
	RequesterPosition       string `json:"requesterPosition,omitempty"`
	ResponderPosition       string `json:"responderPosition,omitempty"`
	RequestorIndex          int    `json:"requestorIndex,omitempty"`
	State                   string `json:"state"`
	Type                    string `json:"type"`
}

func (lf *Lockfile) FetchChampSelectChampionSwaps(ctx context.Context) ([]LCUChampionSwap, error) {
	var swaps []LCUChampionSwap
	for _, prefix := range champSelectSwapRoutePrefixes() {
		if err := lf.getExpansionJSON(ctx, prefix+"champion-swaps", &swaps); err == nil {
			return swaps, nil
		} else if !isRetryableLCURouteError(err) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("champion swap endpoint is unavailable")
}

func (lf *Lockfile) UpdateChampSelectChampionSwap(ctx context.Context, id int64, action string) (LCUChampionSwap, error) {
	if id < 0 {
		return LCUChampionSwap{}, fmt.Errorf("champion swap ID must not be negative")
	}
	if action != "request" && action != "accept" && action != "decline" && action != "cancel" {
		return LCUChampionSwap{}, fmt.Errorf("unsupported champion swap action")
	}
	var result LCUChampionSwap
	var lastErr error
	for _, prefix := range champSelectSwapRoutePrefixes() {
		err := lf.postExpansionJSON(ctx, fmt.Sprintf("%schampion-swaps/%d/%s", prefix, id, action), nil, &result)
		if err == nil {
			return result, nil
		}
		lastErr = err
		if !isRetryableLCURouteError(err) {
			break
		}
	}
	return result, lastErr
}

func (lf *Lockfile) FetchOngoingChampSelectSwaps(ctx context.Context) (map[string]*LCUOngoingSwap, error) {
	result := map[string]*LCUOngoingSwap{"champion": nil, "pickOrder": nil, "position": nil}
	paths := []struct {
		key  string
		path string
	}{
		{"champion", "/lol-champ-select/v1/ongoing-champion-swap"},
		{"pickOrder", "/lol-champ-select/v1/ongoing-pick-order-swap"},
		{"position", "/lol-champ-select/v1/ongoing-position-swap"},
	}
	for _, entry := range paths {
		var swap LCUOngoingSwap
		if err := lf.getExpansionJSON(ctx, entry.path, &swap); err != nil {
			if isRetryableLCURouteError(err) {
				continue
			}
			return nil, err
		}
		result[entry.key] = &swap
	}
	return result, nil
}

func errorsAsLCUStatus(err error, status int) bool {
	if err == nil {
		return false
	}
	if lcuErr, ok := err.(*LCUError); ok {
		return lcuErr.StatusCode == status
	}
	return false
}

func (lf *Lockfile) ClearOngoingChampSelectSwap(ctx context.Context, kind string, id int64) error {
	if id < 0 {
		return fmt.Errorf("ongoing swap ID must not be negative")
	}
	paths := map[string]string{
		"champion":  "/lol-champ-select/v1/ongoing-champion-swap/",
		"pickOrder": "/lol-champ-select/v1/ongoing-pick-order-swap/",
		"position":  "/lol-champ-select/v1/ongoing-position-swap/",
	}
	prefix, ok := paths[kind]
	if !ok {
		return fmt.Errorf("unsupported ongoing swap kind")
	}
	_, err := lf.DoRequest(ctx, http.MethodPost, prefix+strconv.FormatInt(id, 10)+"/clear")
	return err
}

type LCUMatchmakingError struct {
	ID                   int64  `json:"id"`
	ErrorType            string `json:"errorType"`
	Message              string `json:"message"`
	PenalizedSummonerID  int64  `json:"penalizedSummonerId,omitempty"`
	PenaltyTimeRemaining int64  `json:"penaltyTimeRemaining,omitempty"`
}

type LCUMatchmakingDiagnostics struct {
	DodgeData          json.RawMessage       `json:"dodgeData,omitempty"`
	Errors             []LCUMatchmakingError `json:"errors,omitempty"`
	EstimatedQueueTime float64               `json:"estimatedQueueTime"`
	IsCurrentlyInQueue bool                  `json:"isCurrentlyInQueue"`
	LobbyID            string                `json:"lobbyId,omitempty"`
	LowPriorityData    *struct {
		PenalizedSummonerIDs []int64 `json:"penalizedSummonerIds"`
		PenaltyTime          int64   `json:"penaltyTime"`
		PenaltyTimeRemaining int64   `json:"penaltyTimeRemaining"`
		Reason               string  `json:"reason"`
	} `json:"lowPriorityData,omitempty"`
	QueueID     int             `json:"queueId"`
	ReadyCheck  json.RawMessage `json:"readyCheck,omitempty"`
	SearchState string          `json:"searchState"`
	TimeInQueue float64         `json:"timeInQueue"`
}

func (lf *Lockfile) FetchMatchmakingDiagnostics(ctx context.Context) (LCUMatchmakingDiagnostics, []LCUMatchmakingError, error) {
	var diagnostics LCUMatchmakingDiagnostics
	if err := lf.getExpansionJSON(ctx, "/lol-matchmaking/v1/search", &diagnostics); err != nil {
		return diagnostics, nil, err
	}
	errorsList := diagnostics.Errors
	if err := lf.getExpansionJSON(ctx, "/lol-matchmaking/v1/search/errors", &errorsList); err == nil {
		diagnostics.Errors = errorsList
	} else if !isRetryableLCURouteError(err) {
		return diagnostics, nil, err
	}
	return diagnostics, errorsList, nil
}

type LCULeaverNotification struct {
	AccountID                         int64  `json:"accountId"`
	FromRMS                           bool   `json:"fromRms"`
	ID                                int64  `json:"id"`
	MsgID                             string `json:"msgId"`
	PunishedGamesRemaining            int    `json:"punishedGamesRemaining"`
	QueueLockoutTimerExpiryMillisDiff int64  `json:"queueLockoutTimerExpiryUtcMillisDiff"`
	Type                              string `json:"type"`
}

type LCURankedRestriction struct {
	NeedsAck               bool `json:"needsAck"`
	PunishedGamesRemaining int  `json:"punishedGamesRemaining"`
}

func (lf *Lockfile) FetchLeaverBusterStatus(ctx context.Context) ([]LCULeaverNotification, *LCURankedRestriction, error) {
	var notifications []LCULeaverNotification
	if err := lf.getExpansionJSON(ctx, "/lol-leaver-buster/v1/notifications", &notifications); err != nil {
		return nil, nil, err
	}
	var ranked LCURankedRestriction
	if err := lf.getExpansionJSON(ctx, "/lol-leaver-buster/v1/ranked-restriction", &ranked); err != nil {
		if errorsAsLCUStatus(err, http.StatusNotFound) {
			return notifications, nil, nil
		}
		return notifications, nil, err
	}
	return notifications, &ranked, nil
}

func (lf *Lockfile) DismissLeaverNotification(ctx context.Context, id int64) error {
	if id <= 0 {
		return fmt.Errorf("leaver notification ID must be positive")
	}
	_, err := lf.DoRequest(ctx, http.MethodDelete, "/lol-leaver-buster/v1/notifications/"+strconv.FormatInt(id, 10))
	return err
}

type LCUSpectatorConfig struct {
	IsBracketSpectatingEnabled      bool  `json:"isBracketSpectatingEnabled"`
	IsEnabled                       bool  `json:"isEnabled"`
	IsSpectatorDelayConfigurable    bool  `json:"isSpectatorDelayConfigurable"`
	IsUsingClientConfigForSpectator bool  `json:"isUsingClientConfigForSpectator"`
	SpectatableQueues               []int `json:"spectatableQueues"`
}

type LCUSpectateGameInfo struct {
	AllowObserveMode     string `json:"allowObserveMode"`
	DropInSpectateGameID string `json:"dropInSpectateGameId"`
	GameQueueType        string `json:"gameQueueType"`
	PUUID                string `json:"puuid"`
	SpectatorKey         string `json:"spectatorKey"`
}

type LCUCanSpectate struct {
	AvailableForWatching bool   `json:"availableForWatching"`
	Reason               string `json:"reason"`
}

func (lf *Lockfile) FetchSpectatorConfig(ctx context.Context) (LCUSpectatorConfig, error) {
	var config LCUSpectatorConfig
	err := lf.getExpansionJSON(ctx, "/lol-spectator/v1/spectate/config", &config)
	return config, err
}

func (lf *Lockfile) PrepareSpectator(ctx context.Context, puuids []string) ([]string, error) {
	if len(puuids) != 1 || strings.TrimSpace(puuids[0]) == "" {
		return nil, fmt.Errorf("one friend PUUID is required")
	}
	var result struct {
		AvailableForWatching []string `json:"availableForWatching"`
	}
	err := lf.postExpansionJSON(ctx, "/lol-spectator/v3/buddy/spectate", puuids, &result)
	return result.AvailableForWatching, err
}

func (lf *Lockfile) FetchSpectateGameInfo(ctx context.Context) (LCUSpectateGameInfo, error) {
	var info LCUSpectateGameInfo
	err := lf.getExpansionJSON(ctx, "/lol-spectator/v1/spectate", &info)
	return info, err
}

func (lf *Lockfile) CheckCanSpectate(ctx context.Context, puuid, spectatorKey string) (LCUCanSpectate, error) {
	if strings.TrimSpace(puuid) == "" || strings.TrimSpace(spectatorKey) == "" {
		return LCUCanSpectate{}, fmt.Errorf("spectator identity is incomplete")
	}
	var result LCUCanSpectate
	path := "/lol-spectator/v3/buddy/can-spectate/" + url.PathEscape(puuid) + "/" + url.PathEscape(spectatorKey)
	err := lf.getExpansionJSON(ctx, path, &result)
	return result, err
}

func (lf *Lockfile) LaunchSpectator(ctx context.Context, info LCUSpectateGameInfo) error {
	if info.PUUID == "" || info.SpectatorKey == "" {
		return fmt.Errorf("spectator launch information is incomplete")
	}
	return lf.postExpansionJSON(ctx, "/lol-spectator/v1/spectate/launch", info, nil)
}

type LCUCustomGame struct {
	FilledPlayerSlots    int    `json:"filledPlayerSlots"`
	FilledSpectatorSlots int    `json:"filledSpectatorSlots"`
	GameType             string `json:"gameType"`
	HasPassword          bool   `json:"hasPassword"`
	ID                   int64  `json:"id"`
	LobbyName            string `json:"lobbyName"`
	MapID                int    `json:"mapId"`
	MaxPlayerSlots       int    `json:"maxPlayerSlots"`
	MaxSpectatorSlots    int    `json:"maxSpectatorSlots"`
	OwnerDisplayName     string `json:"ownerDisplayName"`
	PartyID              string `json:"partyId,omitempty"`
	PassbackURL          string `json:"passbackUrl,omitempty"`
	SpectatorPolicy      string `json:"spectatorPolicy"`
}

type LCUCustomJoinParameters struct {
	AsSpectator bool   `json:"asSpectator"`
	Password    string `json:"password,omitempty"`
}

type LCUReceivedInvitation struct {
	CanAcceptInvitation bool              `json:"canAcceptInvitation"`
	FromPUUID           string            `json:"fromPuuid"`
	FromSummonerID      int64             `json:"fromSummonerId"`
	FromSummonerName    string            `json:"fromSummonerName"`
	GameConfig          json.RawMessage   `json:"gameConfig,omitempty"`
	InvitationID        string            `json:"invitationId"`
	InvitationType      string            `json:"invitationType"`
	IsSelfInvite        bool              `json:"isSelfInvite"`
	Restrictions        []json.RawMessage `json:"restrictions,omitempty"`
	State               string            `json:"state"`
	Timestamp           string            `json:"timestamp"`
}

func (lf *Lockfile) FetchCustomGames(ctx context.Context) ([]LCUCustomGame, error) {
	var games []LCUCustomGame
	err := lf.getExpansionJSON(ctx, "/lol-lobby/v1/custom-games", &games)
	return games, err
}

func (lf *Lockfile) RefreshCustomGames(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, http.MethodPost, "/lol-lobby/v1/custom-games/refresh")
	return err
}

func (lf *Lockfile) JoinCustomGame(ctx context.Context, id int64, parameters LCUCustomJoinParameters) error {
	if id <= 0 {
		return fmt.Errorf("custom game ID must be positive")
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-lobby/v1/custom-games/"+strconv.FormatInt(id, 10)+"/join", parameters)
	return err
}

func (lf *Lockfile) FetchLobbyAvailability(ctx context.Context) (string, error) {
	body, err := lf.DoRequest(ctx, http.MethodGet, "/lol-lobby/v1/lobby/availability")
	if err != nil {
		return "", err
	}
	var value string
	if json.Unmarshal(body, &value) == nil {
		return value, nil
	}
	var object struct {
		Availability string `json:"availability"`
	}
	if err := json.Unmarshal(body, &object); err != nil {
		return "", fmt.Errorf("decode lobby availability: %w", err)
	}
	return object.Availability, nil
}

func (lf *Lockfile) FetchLobbyCountdown(ctx context.Context) (int64, error) {
	body, err := lf.DoRequest(ctx, http.MethodGet, "/lol-lobby/v1/lobby/countdown")
	if err != nil {
		return 0, err
	}
	var value int64
	if json.Unmarshal(body, &value) == nil {
		return value, nil
	}
	var object struct {
		CountdownMs int64 `json:"countdownMs"`
		Countdown   int64 `json:"countdown"`
	}
	if json.Unmarshal(body, &object) == nil {
		if object.CountdownMs > 0 {
			return object.CountdownMs, nil
		}
		return object.Countdown, nil
	}
	return 0, fmt.Errorf("decode lobby countdown")
}

func (lf *Lockfile) FetchReceivedInvitations(ctx context.Context) ([]LCUReceivedInvitation, error) {
	var invitations []LCUReceivedInvitation
	err := lf.getExpansionJSON(ctx, "/lol-lobby/v2/received-invitations", &invitations)
	return invitations, err
}

func (lf *Lockfile) ActOnReceivedInvitation(ctx context.Context, id, action string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("invitation ID is required")
	}
	if action != "accept" && action != "decline" {
		return fmt.Errorf("unsupported invitation action")
	}
	_, err := lf.DoRequest(ctx, http.MethodPost, "/lol-lobby/v2/received-invitations/"+url.PathEscape(id)+"/"+action)
	return err
}

func (lf *Lockfile) CancelCustomChampSelect(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, http.MethodPost, "/lol-lobby/v1/lobby/custom/cancel-champ-select")
	return err
}

type LCUChatMute struct {
	PUUID           string `json:"puuid"`
	ObfuscatedPUUID string `json:"obfuscatedPuuid,omitempty"`
	PlayerMuted     bool   `json:"isPlayerMuted"`
	SettingsMuted   bool   `json:"isSettingsMuted"`
	SystemMuted     bool   `json:"isSystemMuted"`
}

type LCUChatSettings map[string]any

func (lf *Lockfile) FetchChatMutes(ctx context.Context) ([]LCUChatMute, error) {
	body, err := lf.DoRequest(ctx, http.MethodGet, "/lol-chat/v1/player-mutes")
	if err != nil {
		return nil, err
	}
	var values map[string]LCUChatMute
	if err := json.Unmarshal(body, &values); err == nil {
		result := make([]LCUChatMute, 0, len(values))
		for _, mute := range values {
			result = append(result, mute)
		}
		return result, nil
	}
	var list []LCUChatMute
	if err := decodeExpansionJSON(body, &list); err != nil {
		return nil, err
	}
	return list, nil
}

func (lf *Lockfile) UpdateChatMutes(ctx context.Context, puuids []string, muted bool) error {
	if len(puuids) == 0 || len(puuids) > 100 {
		return fmt.Errorf("select between 1 and 100 players")
	}
	clean := make([]string, 0, len(puuids))
	for _, puuid := range puuids {
		if strings.TrimSpace(puuid) == "" {
			return fmt.Errorf("player PUUID is required")
		}
		clean = append(clean, strings.TrimSpace(puuid))
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-chat/v1/player-mutes", map[string]any{"isMuted": muted, "puuids": clean})
	return err
}

func (lf *Lockfile) FetchChatSettings(ctx context.Context) (LCUChatSettings, error) {
	var settings LCUChatSettings
	err := lf.getExpansionJSON(ctx, "/lol-chat/v1/settings", &settings)
	return settings, err
}

func (lf *Lockfile) UpdateChatSettings(ctx context.Context, settings LCUChatSettings) (LCUChatSettings, error) {
	if len(settings) == 0 {
		return nil, fmt.Errorf("chat settings are empty")
	}
	var updated LCUChatSettings
	if err := lf.doJSONInto(ctx, http.MethodPut, "/lol-chat/v1/settings?doAsync=false", settings, &updated); err != nil {
		return nil, err
	}
	return updated, nil
}

type LCUMission struct {
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Description string            `json:"description"`
	HelperText  string            `json:"helperText,omitempty"`
	Status      string            `json:"status"`
	Viewed      bool              `json:"viewed"`
	StartTime   string            `json:"startTime,omitempty"`
	EndTime     string            `json:"endTime,omitempty"`
	SeriesName  string            `json:"seriesName,omitempty"`
	Sequence    int               `json:"sequence,omitempty"`
	Objectives  []json.RawMessage `json:"objectives,omitempty"`
	Rewards     []json.RawMessage `json:"rewards,omitempty"`
}

type LCUMissionSeries struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	StartDate   string   `json:"startDate,omitempty"`
	EndDate     string   `json:"endDate,omitempty"`
	Type        string   `json:"type,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

func (lf *Lockfile) FetchMissions(ctx context.Context) ([]LCUMission, []LCUMissionSeries, error) {
	var missions []LCUMission
	if err := lf.getExpansionJSON(ctx, "/lol-missions/v1/missions", &missions); err != nil {
		return nil, nil, err
	}
	var series []LCUMissionSeries
	if err := lf.getExpansionJSON(ctx, "/lol-missions/v1/series", &series); err != nil {
		return missions, nil, err
	}
	return missions, series, nil
}

type LCUReward struct {
	ID                string `json:"id"`
	ItemID            string `json:"itemId"`
	ItemType          string `json:"itemType"`
	Quantity          int    `json:"quantity"`
	FulfillmentSource string `json:"fulfillmentSource,omitempty"`
}

type LCURewardGrant struct {
	Info struct {
		ID            string   `json:"id"`
		RewardGroupID string   `json:"rewardGroupId"`
		Status        string   `json:"status"`
		DateCreated   string   `json:"dateCreated"`
		SelectedIDs   []string `json:"selectedIds"`
		Viewed        bool     `json:"viewed"`
	} `json:"info"`
	RewardGroup struct {
		ID                      string      `json:"id"`
		Active                  bool        `json:"active"`
		CelebrationType         string      `json:"celebrationType"`
		RewardStrategy          string      `json:"rewardStrategy"`
		Rewards                 []LCUReward `json:"rewards"`
		SelectionStrategyConfig *struct {
			MinSelectionsAllowed int `json:"minSelectionsAllowed"`
			MaxSelectionsAllowed int `json:"maxSelectionsAllowed"`
		} `json:"selectionStrategyConfig,omitempty"`
	} `json:"rewardGroup"`
}

func (lf *Lockfile) FetchRewardGrants(ctx context.Context, status string) ([]LCURewardGrant, error) {
	allowed := map[string]bool{"PENDING_FULFILLMENT": true, "PENDING_SELECTION": true, "FULFILLED": true, "FAILED": true, "": true}
	status = strings.ToUpper(strings.TrimSpace(status))
	if !allowed[status] {
		return nil, fmt.Errorf("unsupported reward status")
	}
	path := "/lol-rewards/v1/grants"
	if status != "" {
		path += "?status=" + url.QueryEscape(status)
	}
	var grants []LCURewardGrant
	err := lf.getExpansionJSON(ctx, path, &grants)
	return grants, err
}

func (lf *Lockfile) FetchSelectedRewardGrant(ctx context.Context, grantID string, selection map[string]any) (LCURewardGrant, error) {
	if strings.TrimSpace(grantID) == "" {
		return LCURewardGrant{}, fmt.Errorf("grant ID is required")
	}
	var result LCURewardGrant
	err := lf.postExpansionJSON(ctx, "/lol-rewards/v1/grants/"+url.PathEscape(grantID)+"/select", selection, &result)
	return result, err
}

type LCURewardSelection struct {
	GrantID       string   `json:"grantId"`
	RewardGroupID string   `json:"rewardGroupId"`
	Selections    []string `json:"selections"`
}

func (lf *Lockfile) SelectRewardsBulk(ctx context.Context, selections []LCURewardSelection) (map[string]string, error) {
	if len(selections) == 0 || len(selections) > 20 {
		return nil, fmt.Errorf("select between 1 and 20 reward grants")
	}
	for _, selection := range selections {
		if strings.TrimSpace(selection.GrantID) == "" || strings.TrimSpace(selection.RewardGroupID) == "" || len(selection.Selections) == 0 || len(selection.Selections) > 20 {
			return nil, fmt.Errorf("reward selection is invalid")
		}
	}
	var result map[string]string
	err := lf.postExpansionJSON(ctx, "/lol-rewards/v1/select-bulk", selections, &result)
	return result, err
}

func (lf *Lockfile) MarkRewardsViewed(ctx context.Context, ids []string) error {
	if len(ids) == 0 || len(ids) > 100 {
		return fmt.Errorf("select between 1 and 100 grants")
	}
	_, err := lf.doJSON(ctx, http.MethodPatch, "/lol-rewards/v1/grants/view", ids)
	return err
}

func (lf *Lockfile) ReplayRewardGroup(ctx context.Context, rewardGroupID string) error {
	if strings.TrimSpace(rewardGroupID) == "" {
		return fmt.Errorf("reward group ID is required")
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-rewards/v1/reward/replay", rewardGroupID)
	return err
}

type LCUChampionMasteryProgress struct {
	ChampionID                   int      `json:"championId"`
	ChampionLevel                int      `json:"championLevel"`
	ChampionPoints               int64    `json:"championPoints"`
	ChampionPointsSinceLastLevel int64    `json:"championPointsSinceLastLevel"`
	ChampionPointsUntilNextLevel int64    `json:"championPointsUntilNextLevel"`
	HighestGrade                 string   `json:"highestGrade,omitempty"`
	LastPlayTime                 int64    `json:"lastPlayTime,omitempty"`
	MarkRequired                 int      `json:"markRequired,omitempty"`
	Milestone                    int      `json:"milestone,omitempty"`
	MilestoneGrades              []string `json:"milestoneGrades,omitempty"`
	TokensEarned                 int      `json:"tokensEarned,omitempty"`
}

type LCUChampionMasteryRewardGrant struct {
	ID          string `json:"id"`
	ChampionID  int    `json:"championId"`
	GameID      int64  `json:"gameId"`
	MessageKey  string `json:"messageKey"`
	PlayerGrade string `json:"playerGrade"`
	PUUID       string `json:"puuid"`
}

type LCUChampionMasteryNotification struct {
	ChampionID int    `json:"championId,omitempty"`
	GameID     int64  `json:"gameId,omitempty"`
	Points     int64  `json:"championPoints,omitempty"`
	Grade      string `json:"grade,omitempty"`
	Won        bool   `json:"won,omitempty"`
}

type LCUScoutingResult struct {
	PlayerID           int64           `json:"playerId,omitempty"`
	PUUID              string          `json:"puuid"`
	TopMasteries       json.RawMessage `json:"topMasteries,omitempty"`
	TopSeasonChampions json.RawMessage `json:"topSeasonChampions,omitempty"`
	TotalMasteryScore  int64           `json:"totalMasteryScore"`
}

func (lf *Lockfile) FetchMasteryProgress(ctx context.Context) ([]LCUChampionMasteryProgress, int64, json.RawMessage, *LCUChampionMasteryNotification, []LCUChampionMasteryRewardGrant, error) {
	var champions []LCUChampionMasteryProgress
	if err := lf.getExpansionJSON(ctx, "/lol-champion-mastery/v1/local-player/champion-mastery", &champions); err != nil {
		return nil, 0, nil, nil, nil, err
	}
	var score int64
	if err := lf.getExpansionJSON(ctx, "/lol-champion-mastery/v1/local-player/champion-mastery-score", &score); err != nil {
		return champions, 0, nil, nil, nil, err
	}
	var sets json.RawMessage
	if body, err := lf.DoRequest(ctx, http.MethodGet, "/lol-champion-mastery/v1/local-player/champion-mastery-sets-and-rewards"); err == nil {
		sets = body
	}
	var notification *LCUChampionMasteryNotification
	var latest LCUChampionMasteryNotification
	if err := lf.getExpansionJSON(ctx, "/lol-champion-mastery/v1/notifications", &latest); err == nil {
		notification = &latest
	} else if !errorsAsLCUStatus(err, http.StatusNotFound) {
		return champions, score, sets, nil, nil, err
	}
	var grants []LCUChampionMasteryRewardGrant
	if err := lf.getExpansionJSON(ctx, "/lol-champion-mastery/v1/reward-grants", &grants); err != nil && !errorsAsLCUStatus(err, http.StatusNotFound) {
		return champions, score, sets, notification, nil, err
	}
	return champions, score, sets, notification, grants, nil
}

func (lf *Lockfile) AcknowledgeMasteryNotification(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, http.MethodPost, "/lol-champion-mastery/v1/notifications/ack")
	return err
}

func (lf *Lockfile) DismissMasteryRewardGrant(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("mastery reward grant ID is required")
	}
	_, err := lf.DoRequest(ctx, http.MethodDelete, "/lol-champion-mastery/v1/reward-grants/"+url.PathEscape(id))
	return err
}

func (lf *Lockfile) ScoutMastery(ctx context.Context, puuids []string) ([]LCUScoutingResult, error) {
	if len(puuids) == 0 || len(puuids) > 10 {
		return nil, fmt.Errorf("scout between 1 and 10 players")
	}
	var result []LCUScoutingResult
	err := lf.postExpansionJSON(ctx, "/lol-champion-mastery/v1/scouting", puuids, &result)
	return result, err
}

type LCULoadoutItem struct {
	ContentID     string            `json:"contentId"`
	Data          map[string]string `json:"data,omitempty"`
	InventoryType string            `json:"inventoryType"`
	ItemID        int               `json:"itemId"`
}

type LCULoadout struct {
	ID          string                    `json:"id"`
	ItemID      int                       `json:"itemId"`
	Loadout     map[string]LCULoadoutItem `json:"loadout"`
	Name        string                    `json:"name"`
	RefreshTime string                    `json:"refreshTime"`
	Scope       string                    `json:"scope"`
}

func (lf *Lockfile) FetchLoadoutsReady(ctx context.Context) (bool, error) {
	body, err := lf.DoRequest(ctx, http.MethodGet, "/lol-loadouts/v1/loadouts-ready")
	if err != nil {
		return false, err
	}
	var ready bool
	if json.Unmarshal(body, &ready) == nil {
		return ready, nil
	}
	var object struct {
		Ready bool `json:"ready"`
	}
	if err := json.Unmarshal(body, &object); err != nil {
		return false, err
	}
	return object.Ready, nil
}

func (lf *Lockfile) FetchAccountLoadouts(ctx context.Context) ([]LCULoadout, error) {
	var loadouts []LCULoadout
	err := lf.getExpansionJSON(ctx, "/lol-loadouts/v4/loadouts/scope/account", &loadouts)
	return loadouts, err
}

func (lf *Lockfile) FetchScopedLoadouts(ctx context.Context, scope, scopeItemID string) ([]LCULoadout, error) {
	scope = strings.TrimSpace(strings.ToLower(scope))
	scopeItemID = strings.TrimSpace(scopeItemID)
	if scope == "" || scope == "account" || len(scope) > 40 || strings.ContainsAny(scope, "/\\") {
		return nil, fmt.Errorf("loadout scope is invalid")
	}
	if scopeItemID == "" || len(scopeItemID) > 80 {
		return nil, fmt.Errorf("loadout scope item is required")
	}
	var loadouts []LCULoadout
	err := lf.getExpansionJSON(ctx, "/lol-loadouts/v4/loadouts/scope/"+url.PathEscape(scope)+"/"+url.PathEscape(scopeItemID), &loadouts)
	return loadouts, err
}

func (lf *Lockfile) FetchLoadout(ctx context.Context, id string) (LCULoadout, error) {
	if strings.TrimSpace(id) == "" {
		return LCULoadout{}, fmt.Errorf("loadout ID is required")
	}
	var loadout LCULoadout
	err := lf.getExpansionJSON(ctx, "/lol-loadouts/v4/loadouts/"+url.PathEscape(id), &loadout)
	return loadout, err
}

func (lf *Lockfile) UpdateLoadout(ctx context.Context, loadout LCULoadout) (LCULoadout, error) {
	if strings.TrimSpace(loadout.ID) == "" || strings.TrimSpace(loadout.Name) == "" {
		return LCULoadout{}, fmt.Errorf("loadout ID and name are required")
	}
	var updated LCULoadout
	err := lf.doJSONInto(ctx, http.MethodPatch, "/lol-loadouts/v4/loadouts/"+url.PathEscape(loadout.ID), loadout, &updated)
	return updated, err
}

func (lf *Lockfile) DeleteLoadout(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("loadout ID is required")
	}
	_, err := lf.DoRequest(ctx, http.MethodDelete, "/lol-loadouts/v4/loadouts/"+url.PathEscape(id))
	return err
}

func (lf *Lockfile) doJSONInto(ctx context.Context, method, path string, payload, target any) error {
	body, err := lf.doJSON(ctx, method, path, payload)
	if err != nil {
		return err
	}
	if target == nil || len(body) == 0 {
		return nil
	}
	return decodeExpansionJSON(body, target)
}
