package riotclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// The methods in this file are intentionally small, typed wrappers around
// known League client surfaces. They are not a general-purpose LCU proxy.

func (lf *Lockfile) FetchFriendRequests(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-chat/v1/friend-requests")
}

func (lf *Lockfile) FetchFriendGroups(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-chat/v1/friend-groups")
}

func validateNumericID(value string, label string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, fmt.Errorf("%s is required", label)
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", label)
	}
	return parsed, nil
}

func (lf *Lockfile) UpdateFriendRequest(ctx context.Context, pid, direction string) error {
	if _, err := validateNumericID(pid, "friend request id"); err != nil {
		return err
	}
	direction = strings.ToLower(strings.TrimSpace(direction))
	if direction != "both" && direction != "in" && direction != "out" {
		return fmt.Errorf("friend request direction must be both, in, or out")
	}
	_, err := lf.doJSON(ctx, http.MethodPut, "/lol-chat/v1/friend-requests/"+url.PathEscape(strings.TrimSpace(pid)), map[string]string{"direction": direction})
	return err
}

func (lf *Lockfile) DeleteFriendRequest(ctx context.Context, pid string) error {
	if _, err := validateNumericID(pid, "friend request id"); err != nil {
		return err
	}
	_, err := lf.DoRequest(ctx, http.MethodDelete, "/lol-chat/v1/friend-requests/"+url.PathEscape(strings.TrimSpace(pid)))
	return err
}

func (lf *Lockfile) RemoveFriend(ctx context.Context, pid string) error {
	if _, err := validateNumericID(pid, "friend id"); err != nil {
		return err
	}
	_, err := lf.DoRequest(ctx, http.MethodDelete, "/lol-chat/v1/friends/"+url.PathEscape(strings.TrimSpace(pid)))
	return err
}

func (lf *Lockfile) InviteFriends(ctx context.Context, summonerIDs []string) error {
	if len(summonerIDs) == 0 || len(summonerIDs) > 20 {
		return fmt.Errorf("select between 1 and 20 friends to invite")
	}
	payload := make([]map[string]int64, 0, len(summonerIDs))
	for _, id := range summonerIDs {
		parsed, err := validateNumericID(id, "summoner id")
		if err != nil {
			return err
		}
		payload = append(payload, map[string]int64{"toSummonerId": parsed})
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-lobby/v2/lobby/invitations", payload)
	return err
}

func (lf *Lockfile) FetchCustomBots(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-lobby/v2/lobby/custom/available-bots")
}

func (lf *Lockfile) AddCustomBot(ctx context.Context, championID int, difficulty, teamID string) error {
	if championID <= 0 {
		return fmt.Errorf("champion id must be positive")
	}
	difficulty = strings.ToUpper(strings.TrimSpace(difficulty))
	allowedDifficulty := map[string]bool{"NONE": true, "EASY": true, "MEDIUM": true, "HARD": true, "UBER": true, "TUTORIAL": true, "INTRO": true}
	if !allowedDifficulty[difficulty] {
		return fmt.Errorf("unsupported bot difficulty")
	}
	if teamID != "100" && teamID != "200" {
		return fmt.Errorf("team id must be 100 or 200")
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-lobby/v1/lobby/custom/bots", map[string]any{
		"botDifficulty": difficulty, "championId": championID, "teamId": teamID,
	})
	return err
}

func (lf *Lockfile) TogglePlayerMuted(ctx context.Context, payload map[string]any) error {
	if payload == nil {
		return fmt.Errorf("player payload is required")
	}
	if _, ok := payload["puuid"].(string); !ok || strings.TrimSpace(payload["puuid"].(string)) == "" {
		return fmt.Errorf("player PUUID is required")
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-champ-select/v1/toggle-player-muted", payload)
	return err
}

func (lf *Lockfile) FetchGameSettings(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-game-settings/v1/game-settings")
}

func (lf *Lockfile) FetchInputSettings(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-game-settings/v1/input-settings")
}

func (lf *Lockfile) PatchGameSettings(ctx context.Context, payload json.RawMessage) error {
	if len(payload) == 0 || !json.Valid(payload) {
		return fmt.Errorf("game settings payload is invalid")
	}
	_, err := lf.doRequest(ctx, http.MethodPatch, "/lol-game-settings/v1/game-settings", strings.NewReader(string(payload)))
	return err
}

func (lf *Lockfile) PatchInputSettings(ctx context.Context, payload json.RawMessage) error {
	if len(payload) == 0 || !json.Valid(payload) {
		return fmt.Errorf("input settings payload is invalid")
	}
	_, err := lf.doRequest(ctx, http.MethodPatch, "/lol-game-settings/v1/input-settings", strings.NewReader(string(payload)))
	return err
}

func (lf *Lockfile) SaveGameSettings(ctx context.Context) error {
	_, err := lf.DoRequest(ctx, http.MethodPost, "/lol-game-settings/v1/save")
	return err
}

func (lf *Lockfile) FetchItemSets(ctx context.Context, summonerID int64) ([]byte, error) {
	if summonerID <= 0 {
		return nil, fmt.Errorf("summoner id must be positive")
	}
	return lf.DoRequest(ctx, http.MethodGet, fmt.Sprintf("/lol-item-sets/v1/item-sets/%d/sets", summonerID))
}

func (lf *Lockfile) UpdateItemSets(ctx context.Context, summonerID int64, payload json.RawMessage) error {
	if summonerID <= 0 || len(payload) == 0 || !json.Valid(payload) {
		return fmt.Errorf("item-set payload is invalid")
	}
	_, err := lf.doRequest(ctx, http.MethodPut, fmt.Sprintf("/lol-item-sets/v1/item-sets/%d/sets", summonerID), strings.NewReader(string(payload)))
	return err
}

func (lf *Lockfile) FetchReplayMetadata(ctx context.Context, gameID string) ([]byte, error) {
	id, err := validateNumericID(gameID, "game id")
	if err != nil {
		return nil, err
	}
	return lf.DoRequest(ctx, http.MethodGet, fmt.Sprintf("/lol-replays/v1/metadata/%d", id))
}

func (lf *Lockfile) DownloadReplay(ctx context.Context, gameID string) error {
	id, err := validateNumericID(gameID, "game id")
	if err != nil {
		return err
	}
	_, err = lf.DoRequest(ctx, http.MethodPost, fmt.Sprintf("/lol-replays/v1/rofls/%d/download", id))
	return err
}

func (lf *Lockfile) WatchReplay(ctx context.Context, gameID string) error {
	id, err := validateNumericID(gameID, "game id")
	if err != nil {
		return err
	}
	_, err = lf.DoRequest(ctx, http.MethodPost, fmt.Sprintf("/lol-replays/v1/rofls/%d/watch", id))
	return err
}

func (lf *Lockfile) FetchPendingRewards(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-rewards/v1/grants?status=PENDING_SELECTION")
}

func (lf *Lockfile) FetchProfileRegalia(ctx context.Context) ([]byte, error) {
	// Read-only inventory surfaces. Mutation is intentionally not implemented
	// until the League client exposes a stable ownership-checked contract.
	return lf.DoRequest(ctx, http.MethodGet, "/lol-regalia/v2/current-summoner/regalia")
}

func (lf *Lockfile) FetchChallengeTitles(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-challenges/v1/titles/local-player")
}

func (lf *Lockfile) FetchChallengeTokens(ctx context.Context) ([]byte, error) {
	return lf.DoRequest(ctx, http.MethodGet, "/lol-challenges/v1/challenges/local-player")
}

func (lf *Lockfile) SelectReward(ctx context.Context, grantID, rewardGroupID string, selections []string) error {
	grantID = strings.TrimSpace(grantID)
	rewardGroupID = strings.TrimSpace(rewardGroupID)
	if grantID == "" || rewardGroupID == "" || len(selections) == 0 || len(selections) > 20 {
		return fmt.Errorf("reward grant, group, and selections are required")
	}
	for _, selection := range selections {
		if strings.TrimSpace(selection) == "" || len(selection) > 160 {
			return fmt.Errorf("reward selection is invalid")
		}
	}
	_, err := lf.doJSON(ctx, http.MethodPost, "/lol-rewards/v1/grants/"+url.PathEscape(grantID)+"/select", map[string]any{
		"grantId": grantID, "rewardGroupId": rewardGroupID, "selections": selections,
	})
	return err
}
