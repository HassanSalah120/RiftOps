package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/featurestore"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

type reviewedOperation struct {
	mu           sync.Mutex
	ID           string
	Kind         string
	TargetIDs    []string
	Confirmation string
	State        string
	Completed    int
	Results      []featurestore.BatchItemResult
	CreatedAt    time.Time
	ExpiresAt    time.Time
	Cancel       chan struct{}
	Started      bool
	LootItems    map[string]lootOperationItem
	Expansion    *expansionOperation
}

type lootOperationItem struct {
	TargetID   string   `json:"targetId"`
	LootID     string   `json:"lootId"`
	RecipeName string   `json:"recipeName"`
	LootIDs    []string `json:"lootIds"`
	Repeat     int      `json:"repeat"`
	Label      string   `json:"label,omitempty"`
	Outputs    any      `json:"outputs,omitempty"`
}

type rewardSelectionOperation struct {
	GrantID       string   `json:"grantId"`
	RewardGroupID string   `json:"rewardGroupId"`
	Selections    []string `json:"selections"`
}

type expansionOperation struct {
	RewardSelections []rewardSelectionOperation
	CustomJoin       *struct {
		GameID      int64
		AsSpectator bool
		Password    string
	}
	InvitationID  string
	CustomLobbyID string
	LoadoutID     string
	LoadoutName   string
	MutePUUIDs    []string
	MuteValue     bool
}

var reviewedOperations = struct {
	sync.Mutex
	items map[string]*reviewedOperation
}{items: make(map[string]*reviewedOperation)}

func operationID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err == nil {
		return "op-" + hex.EncodeToString(buffer)
	}
	return fmt.Sprintf("op-%d", time.Now().UnixNano())
}

func operationPreviewHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		httpError(w, "Bulk operations are desktop-only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Kind             string                     `json:"kind"`
		TargetIDs        []string                   `json:"targetIds"`
		LootItems        []lootOperationItem        `json:"lootItems"`
		RewardSelections []rewardSelectionOperation `json:"rewardSelections"`
		CustomJoin       *struct {
			GameID      int64  `json:"gameId"`
			AsSpectator bool   `json:"asSpectator"`
			Password    string `json:"password"`
		} `json:"customJoin"`
		Invitation *struct {
			InvitationID string `json:"invitationId"`
		} `json:"invitation"`
		CustomSession *struct {
			LobbyID string `json:"lobbyId"`
		} `json:"customSession"`
		LoadoutChange *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"loadoutChange"`
		MuteUpdate *struct {
			PUUIDs []string `json:"puuids"`
			Muted  bool     `json:"muted"`
		} `json:"muteUpdate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid operation preview", http.StatusBadRequest)
		return
	}
	body.Kind = strings.ToLower(strings.TrimSpace(body.Kind))
	allowedKind := map[string]bool{
		"friend-remove": true, "friend-invite": true, "request-accept": true, "request-decline": true, "loot-craft": true,
		"reward-select": true, "reward-select-bulk": true, "custom-game-join": true, "lobby-invitation-accept": true,
		"custom-champ-select-cancel": true, "loadout-rename": true, "loadout-delete": true, "chat-mute-bulk": true,
	}
	if !allowedKind[body.Kind] {
		httpError(w, "Unsupported reviewed operation", http.StatusBadRequest)
		return
	}
	var expansion *expansionOperation
	if body.Kind == "reward-select" || body.Kind == "reward-select-bulk" {
		if len(body.RewardSelections) == 0 || len(body.RewardSelections) > 20 || (body.Kind == "reward-select" && len(body.RewardSelections) != 1) {
			httpError(w, "Select between 1 and 20 reward grants", http.StatusBadRequest)
			return
		}
		expansion = &expansionOperation{RewardSelections: body.RewardSelections}
		for index := range expansion.RewardSelections {
			selection := &expansion.RewardSelections[index]
			selection.GrantID = strings.TrimSpace(selection.GrantID)
			selection.RewardGroupID = strings.TrimSpace(selection.RewardGroupID)
			if selection.GrantID == "" || selection.RewardGroupID == "" || len(selection.Selections) == 0 || len(selection.Selections) > 20 {
				httpError(w, "Reward selection input is invalid", http.StatusBadRequest)
				return
			}
			seenSelections := make(map[string]struct{}, len(selection.Selections))
			for selectionIndex := range selection.Selections {
				selection.Selections[selectionIndex] = strings.TrimSpace(selection.Selections[selectionIndex])
				if selection.Selections[selectionIndex] == "" || len(selection.Selections[selectionIndex]) > 160 {
					httpError(w, "Reward selection input is invalid", http.StatusBadRequest)
					return
				}
				if _, exists := seenSelections[selection.Selections[selectionIndex]]; exists {
					httpError(w, "Reward selections must be unique", http.StatusBadRequest)
					return
				}
				seenSelections[selection.Selections[selectionIndex]] = struct{}{}
			}
			body.TargetIDs = append(body.TargetIDs, selection.GrantID)
		}
	} else if body.Kind == "custom-game-join" {
		if body.CustomJoin == nil || body.CustomJoin.GameID <= 0 || len(body.CustomJoin.Password) > 128 {
			httpError(w, "Custom-game join input is invalid", http.StatusBadRequest)
			return
		}
		expansion = &expansionOperation{CustomJoin: &struct {
			GameID      int64
			AsSpectator bool
			Password    string
		}{body.CustomJoin.GameID, body.CustomJoin.AsSpectator, body.CustomJoin.Password}}
		body.TargetIDs = []string{fmt.Sprintf("custom-game-%d", body.CustomJoin.GameID)}
	} else if body.Kind == "lobby-invitation-accept" {
		if body.Invitation == nil || strings.TrimSpace(body.Invitation.InvitationID) == "" || len(body.Invitation.InvitationID) > 160 {
			httpError(w, "Invitation input is invalid", http.StatusBadRequest)
			return
		}
		expansion = &expansionOperation{InvitationID: strings.TrimSpace(body.Invitation.InvitationID)}
		body.TargetIDs = []string{expansion.InvitationID}
	} else if body.Kind == "custom-champ-select-cancel" {
		if body.CustomSession == nil || strings.TrimSpace(body.CustomSession.LobbyID) == "" || len(body.CustomSession.LobbyID) > 160 {
			httpError(w, "Custom session input is invalid", http.StatusBadRequest)
			return
		}
		expansion = &expansionOperation{CustomLobbyID: strings.TrimSpace(body.CustomSession.LobbyID)}
		body.TargetIDs = []string{expansion.CustomLobbyID}
	} else if body.Kind == "loadout-rename" || body.Kind == "loadout-delete" {
		if body.LoadoutChange == nil || strings.TrimSpace(body.LoadoutChange.ID) == "" || len(body.LoadoutChange.ID) > 160 || (body.Kind == "loadout-rename" && (strings.TrimSpace(body.LoadoutChange.Name) == "" || len(body.LoadoutChange.Name) > 80)) {
			httpError(w, "Loadout input is invalid", http.StatusBadRequest)
			return
		}
		expansion = &expansionOperation{LoadoutID: strings.TrimSpace(body.LoadoutChange.ID), LoadoutName: strings.TrimSpace(body.LoadoutChange.Name)}
		body.TargetIDs = []string{expansion.LoadoutID}
	} else if body.Kind == "chat-mute-bulk" {
		if body.MuteUpdate == nil || len(body.MuteUpdate.PUUIDs) == 0 || len(body.MuteUpdate.PUUIDs) > 100 {
			httpError(w, "Select between 1 and 100 players", http.StatusBadRequest)
			return
		}
		seenPUUIDs := make(map[string]struct{}, len(body.MuteUpdate.PUUIDs))
		cleanPUUIDs := make([]string, 0, len(body.MuteUpdate.PUUIDs))
		for _, rawPUUID := range body.MuteUpdate.PUUIDs {
			puuid := strings.TrimSpace(rawPUUID)
			if puuid == "" || len(puuid) > 160 {
				httpError(w, "A valid player PUUID is required", http.StatusBadRequest)
				return
			}
			if _, exists := seenPUUIDs[puuid]; exists {
				continue
			}
			seenPUUIDs[puuid] = struct{}{}
			cleanPUUIDs = append(cleanPUUIDs, puuid)
		}
		if len(cleanPUUIDs) == 0 {
			httpError(w, "Select at least one player", http.StatusBadRequest)
			return
		}
		expansion = &expansionOperation{MutePUUIDs: cleanPUUIDs, MuteValue: body.MuteUpdate.Muted}
		body.TargetIDs = []string{"chat-mute-bulk"}
	} else if body.Kind == "loot-craft" {
		body.TargetIDs = nil
		if len(body.LootItems) == 0 || len(body.LootItems) > 20 {
			httpError(w, "Select between 1 and 20 loot recipes", http.StatusBadRequest)
			return
		}
	} else if len(body.TargetIDs) == 0 || len(body.TargetIDs) > 100 {
		httpError(w, "Select between 1 and 100 targets", http.StatusBadRequest)
		return
	}
	// Lobby invitations are intentionally narrower than the generic reviewed
	// operation envelope. Keep the product contract (20 desktop targets) at
	// the operation boundary as well as in the direct invite handler so a
	// crafted request cannot bypass the limit.
	if body.Kind == "friend-invite" && len(body.TargetIDs) > 20 {
		httpError(w, "Select at most 20 friends for an invitation", http.StatusBadRequest)
		return
	}
	seen := make(map[string]struct{}, len(body.TargetIDs))
	clean := make([]string, 0, len(body.TargetIDs))
	resolvedLoot := make(map[string]lootOperationItem)
	if body.Kind == "loot-craft" {
		lf := safeLCU(w)
		if lf == nil {
			return
		}
		for index, item := range body.LootItems {
			item.LootID, item.RecipeName, item.Label = strings.TrimSpace(item.LootID), strings.TrimSpace(item.RecipeName), strings.TrimSpace(item.Label)
			if item.LootID == "" || item.RecipeName == "" || len(item.LootID) > 160 || len(item.RecipeName) > 160 || len(item.LootIDs) == 0 || len(item.LootIDs) > 20 || item.Repeat < 1 || item.Repeat > 100 {
				httpError(w, "Loot recipe input is invalid", http.StatusBadRequest)
				return
			}
			for idIndex := range item.LootIDs {
				item.LootIDs[idIndex] = strings.TrimSpace(item.LootIDs[idIndex])
				if item.LootIDs[idIndex] == "" || len(item.LootIDs[idIndex]) > 160 {
					httpError(w, "Loot recipe input is invalid", http.StatusBadRequest)
					return
				}
			}
			recipes, err := lf.FetchLCULootRecipes(r.Context(), item.LootID)
			if err != nil {
				httpError(w, "League could not verify a selected loot recipe", http.StatusConflict)
				return
			}
			resolved, ok := findLootRecipe(recipes, item.RecipeName)
			if !ok {
				httpError(w, "A selected loot recipe is no longer available", http.StatusConflict)
				return
			}
			inventory, inventoryErr := lf.FetchLCULoot(r.Context())
			if inventoryErr != nil || !lootInputsAvailable(resolved, inventory, item.LootIDs, item.Repeat) {
				httpError(w, "A selected loot recipe does not have enough verified inputs", http.StatusConflict)
				return
			}
			item.TargetID = fmt.Sprintf("loot-%d-%s", index+1, hex.EncodeToString([]byte(item.RecipeName))[:min(12, len(hex.EncodeToString([]byte(item.RecipeName))))])
			item.Outputs = resolved["outputs"]
			if item.Label == "" {
				item.Label = item.RecipeName
			}
			clean = append(clean, item.TargetID)
			resolvedLoot[item.TargetID] = item
		}
	}
	for _, target := range body.TargetIDs {
		target = strings.TrimSpace(target)
		if target == "" || len(target) > 64 {
			httpError(w, "Operation target is invalid", http.StatusBadRequest)
			return
		}
		if _, exists := seen[target]; exists {
			continue
		}
		seen[target] = struct{}{}
		clean = append(clean, target)
	}
	if len(clean) == 0 {
		httpError(w, "Select at least one target", http.StatusBadRequest)
		return
	}
	verb := map[string]string{"friend-remove": "REMOVE", "friend-invite": "INVITE", "request-accept": "ACCEPT", "request-decline": "DECLINE", "loot-craft": "CRAFT", "reward-select": "SELECT", "reward-select-bulk": "SELECT", "custom-game-join": "JOIN", "lobby-invitation-accept": "ACCEPT", "custom-champ-select-cancel": "CANCEL", "loadout-rename": "RENAME", "loadout-delete": "DELETE", "chat-mute-bulk": "UPDATE"}[body.Kind]
	noun := map[string]string{"friend-remove": "FRIENDS", "friend-invite": "FRIENDS", "request-accept": "REQUESTS", "request-decline": "REQUESTS", "loot-craft": "RECIPES", "reward-select": "REWARD", "reward-select-bulk": "REWARDS", "custom-game-join": "CUSTOM GAME", "lobby-invitation-accept": "INVITATION", "custom-champ-select-cancel": "CHAMPION SELECT", "loadout-rename": "LOADOUT", "loadout-delete": "LOADOUT", "chat-mute-bulk": "CHAT MUTES"}[body.Kind]
	op := &reviewedOperation{ID: operationID(), Kind: body.Kind, TargetIDs: clean, Confirmation: fmt.Sprintf("%s %d %s", verb, len(clean), noun), State: "preview", CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(2 * time.Minute).UTC(), Cancel: make(chan struct{}), LootItems: resolvedLoot, Expansion: expansion}
	reviewedOperations.Lock()
	reviewedOperations.items[op.ID] = op
	reviewedOperations.Unlock()
	lootPreview := make([]lootOperationItem, 0, len(op.LootItems))
	for _, target := range op.TargetIDs {
		if item, ok := op.LootItems[target]; ok {
			lootPreview = append(lootPreview, item)
		}
	}
	details := map[string]any{}
	if expansion != nil {
		details["targetCount"] = len(op.TargetIDs)
		if expansion.CustomJoin != nil {
			details["gameId"] = expansion.CustomJoin.GameID
			details["asSpectator"] = expansion.CustomJoin.AsSpectator
		}
		if expansion.LoadoutID != "" {
			details["loadoutId"] = expansion.LoadoutID
			details["name"] = expansion.LoadoutName
		}
		if expansion.InvitationID != "" {
			details["invitationId"] = expansion.InvitationID
		}
	}
	writeSafeJSON(w, map[string]any{"id": op.ID, "kind": op.Kind, "targetIds": op.TargetIDs, "lootItems": lootPreview, "confirmation": op.Confirmation, "expiresAt": op.ExpiresAt, "state": op.State, "details": details})
}

func findLootRecipe(body []byte, recipeName string) (map[string]any, bool) {
	var decoded any
	if json.Unmarshal(body, &decoded) != nil {
		return nil, false
	}
	var find func(any) (map[string]any, bool)
	find = func(value any) (map[string]any, bool) {
		switch current := value.(type) {
		case []any:
			for _, child := range current {
				if result, ok := find(child); ok {
					return result, true
				}
			}
		case map[string]any:
			if strings.TrimSpace(fmt.Sprint(current["recipeName"])) == recipeName {
				return current, true
			}
			for _, child := range current {
				if result, ok := find(child); ok {
					return result, true
				}
			}
		}
		return nil, false
	}
	return find(decoded)
}

func lootInventoryCounts(body []byte) map[string]int {
	var decoded any
	if json.Unmarshal(body, &decoded) != nil {
		return nil
	}
	counts := make(map[string]int)
	var visit func(any)
	visit = func(value any) {
		switch current := value.(type) {
		case []any:
			for _, child := range current {
				visit(child)
			}
		case map[string]any:
			if id := strings.TrimSpace(fmt.Sprint(current["lootId"])); id != "" {
				if count, ok := current["count"].(float64); ok && count >= 0 {
					counts[id] = int(count)
				}
			}
			for _, child := range current {
				visit(child)
			}
		}
	}
	visit(decoded)
	return counts
}

func lootInputsAvailable(recipe map[string]any, inventory []byte, selected []string, repeat int) bool {
	counts := lootInventoryCounts(inventory)
	if counts == nil || repeat < 1 {
		return false
	}
	slots, _ := recipe["slots"].([]any)
	if len(slots) == 0 {
		for _, id := range selected {
			if counts[id] < repeat {
				return false
			}
		}
		return len(selected) > 0
	}
	used := make(map[string]int)
	for _, raw := range slots {
		slot, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		allowedRaw, _ := slot["lootIds"].([]any)
		allowed := make(map[string]bool, len(allowedRaw))
		for _, value := range allowedRaw {
			allowed[strings.TrimSpace(fmt.Sprint(value))] = true
		}
		chosen := ""
		for _, id := range selected {
			if allowed[id] {
				chosen = id
				break
			}
		}
		if chosen == "" {
			return false
		}
		quantity := 1
		if value, ok := slot["quantity"].(float64); ok && value > 0 {
			quantity = int(value)
		}
		used[chosen] += quantity * repeat
	}
	for id, required := range used {
		if counts[id] < required {
			return false
		}
	}
	return true
}

func lookupOperation(id string) *reviewedOperation {
	reviewedOperations.Lock()
	defer reviewedOperations.Unlock()
	return reviewedOperations.items[strings.TrimSpace(id)]
}

func operationExecuteHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		httpError(w, "Bulk operations are desktop-only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ID           string `json:"id"`
		Confirmation string `json:"confirmation"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid operation execution", http.StatusBadRequest)
		return
	}
	op := lookupOperation(body.ID)
	if op == nil {
		httpError(w, "Operation preview was not found", http.StatusNotFound)
		return
	}
	op.mu.Lock()
	if time.Now().After(op.ExpiresAt) {
		op.State = "expired"
		op.mu.Unlock()
		httpError(w, "Operation preview expired", http.StatusConflict)
		return
	}
	if op.Started || op.State != "preview" {
		state := op.State
		op.mu.Unlock()
		httpError(w, "Operation is already "+state, http.StatusConflict)
		return
	}
	if strings.TrimSpace(body.Confirmation) != op.Confirmation {
		op.mu.Unlock()
		httpError(w, "Confirmation text does not match", http.StatusBadRequest)
		return
	}
	op.Started, op.State = true, "running"
	op.mu.Unlock()
	go runReviewedOperation(op)
	writeSafeJSON(w, map[string]any{"id": op.ID, "state": "running"})
}

func operationStatusHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		httpError(w, "Bulk operations are desktop-only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	op := lookupOperation(r.URL.Query().Get("id"))
	if op == nil {
		httpError(w, "Operation was not found", http.StatusNotFound)
		return
	}
	op.mu.Lock()
	defer op.mu.Unlock()
	results := append([]featurestore.BatchItemResult(nil), op.Results...)
	writeSafeJSON(w, map[string]any{"id": op.ID, "kind": op.Kind, "state": op.State, "total": len(op.TargetIDs), "completed": op.Completed, "results": results, "expiresAt": op.ExpiresAt})
}

func operationCancelHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		httpError(w, "Bulk operations are desktop-only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Operation id is required", http.StatusBadRequest)
		return
	}
	op := lookupOperation(body.ID)
	if op == nil {
		httpError(w, "Operation was not found", http.StatusNotFound)
		return
	}
	op.mu.Lock()
	if op.State == "running" {
		close(op.Cancel)
		op.State = "cancelling"
	}
	state := op.State
	op.mu.Unlock()
	writeSafeJSON(w, map[string]any{"id": op.ID, "state": state})
}

// operationReceiptsHandler returns only the bounded, redacted receipt ledger
// persisted by completed reviewed operations. It is intentionally desktop
// only: receipts can reveal the user's social or inventory actions.
func operationReceiptsHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		httpError(w, "Operation receipts are desktop-only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	receipts := store.Snapshot().BatchReceipts
	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	filtered := make([]featurestore.BatchReceipt, 0, len(receipts))
	for _, receipt := range receipts {
		if receipt.CreatedAt.After(cutoff) {
			filtered = append(filtered, receipt)
		}
	}
	if len(filtered) > 20 {
		filtered = filtered[len(filtered)-20:]
	}
	writeSafeJSON(w, filtered)
}

func operationReceiptsClearHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		httpError(w, "Operation receipts are desktop-only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := requireFeatureStore(w)
	if store == nil {
		return
	}
	if err := store.Update(func(data *featurestore.Data) error {
		data.BatchReceipts = nil
		return nil
	}); err != nil {
		httpError(w, "Could not clear operation receipts", http.StatusInternalServerError)
		return
	}
	writeSafeJSON(w, map[string]bool{"ok": true})
}

func runReviewedOperation(op *reviewedOperation) {
	lf := riotclient.GetLCULockfile()
	if lf == nil {
		finishOperation(op, false, "League Client is not connected")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if op.Expansion != nil {
		runExpansionOperation(op, lf, ctx)
		return
	}
	for _, target := range op.TargetIDs {
		select {
		case <-op.Cancel:
			finishOperation(op, true, "Cancelled by user")
			return
		default:
		}
		present, err := operationTargetPresent(ctx, lf, op.Kind, target, op.LootItems[target])
		if err != nil {
			finishOperation(op, false, "Could not revalidate the target; no automatic retry was attempted")
			return
		}
		result := featurestore.BatchItemResult{TargetID: target}
		if !present {
			result.Status, result.Detail = "skipped", "Target is no longer present in League"
		} else {
			var actionErr error
			switch op.Kind {
			case "friend-remove":
				actionErr = lf.RemoveFriend(ctx, target)
			case "friend-invite":
				actionErr = lf.InviteFriends(ctx, []string{target})
			case "request-accept":
				actionErr = lf.UpdateFriendRequest(ctx, target, "both")
			case "request-decline":
				actionErr = lf.DeleteFriendRequest(ctx, target)
			case "loot-craft":
				item := op.LootItems[target]
				_, actionErr = lf.CraftLCULootRecipe(ctx, item.RecipeName, item.LootIDs, item.Repeat)
			}
			if actionErr != nil {
				result.Status, result.Detail = "failed", "League rejected this target"
				if mutationResultAmbiguous(actionErr) {
					op.mu.Lock()
					op.Results = append(op.Results, result)
					op.Completed++
					op.mu.Unlock()
					finishOperation(op, false, "League returned an ambiguous mutation result; processing stopped and no retry was attempted")
					return
				}
			} else {
				result.Status = "succeeded"
			}
		}
		op.mu.Lock()
		op.Results = append(op.Results, result)
		op.Completed++
		op.mu.Unlock()
		select {
		case <-ctx.Done():
			finishOperation(op, false, "Operation timed out; no automatic retry was attempted")
			return
		case <-time.After(map[bool]time.Duration{true: 500 * time.Millisecond, false: 250 * time.Millisecond}[op.Kind == "friend-invite"]):
		}
	}
	finishOperation(op, false, "")
}

func runExpansionOperation(op *reviewedOperation, lf *riotclient.Lockfile, ctx context.Context) {
	if op.Expansion == nil {
		finishOperation(op, false, "")
		return
	}
	if expansionCancelled(op) {
		finishOperation(op, true, "Cancelled by user")
		return
	}
	result := featurestore.BatchItemResult{TargetID: op.TargetIDs[0], Status: "failed"}
	var actionErr error
	switch op.Kind {
	case "reward-select", "reward-select-bulk":
		grants, err := lf.FetchRewardGrants(ctx, "PENDING_SELECTION")
		if err != nil {
			actionErr = err
			break
		}
		byID := make(map[string]riotclient.LCURewardGrant, len(grants))
		for _, grant := range grants {
			byID[grant.Info.ID] = grant
		}
		validatedSelections := make([]rewardSelectionOperation, 0, len(op.Expansion.RewardSelections))
		for _, selection := range op.Expansion.RewardSelections {
			grant, ok := byID[selection.GrantID]
			if !ok || grant.Info.Status != "PENDING_SELECTION" || grant.Info.RewardGroupID != selection.RewardGroupID {
				actionErr = fmt.Errorf("reward grant changed")
				break
			}
			cleanSelections, validationErr := validateRewardSelections(grant, selection.Selections)
			if validationErr != nil {
				actionErr = validationErr
				break
			}
			selection.Selections = cleanSelections
			validatedSelections = append(validatedSelections, selection)
		}
		if actionErr == nil {
			if op.Kind == "reward-select-bulk" {
				bulk := make([]riotclient.LCURewardSelection, 0, len(validatedSelections))
				for _, selection := range validatedSelections {
					bulk = append(bulk, riotclient.LCURewardSelection{GrantID: selection.GrantID, RewardGroupID: selection.RewardGroupID, Selections: selection.Selections})
				}
				_, actionErr = lf.SelectRewardsBulk(ctx, bulk)
			} else {
				for _, selection := range validatedSelections {
					if err := lf.SelectReward(ctx, selection.GrantID, selection.RewardGroupID, selection.Selections); err != nil {
						actionErr = err
						break
					}
				}
			}
		}
	case "custom-game-join":
		games, err := lf.FetchCustomGames(ctx)
		if err != nil {
			actionErr = err
			break
		}
		found := false
		for _, game := range games {
			if game.ID == op.Expansion.CustomJoin.GameID {
				found = true
				break
			}
		}
		if !found {
			actionErr = fmt.Errorf("custom game is no longer available")
			break
		}
		actionErr = lf.JoinCustomGame(ctx, op.Expansion.CustomJoin.GameID, riotclient.LCUCustomJoinParameters{AsSpectator: op.Expansion.CustomJoin.AsSpectator, Password: op.Expansion.CustomJoin.Password})
	case "lobby-invitation-accept":
		invitations, err := lf.FetchReceivedInvitations(ctx)
		if err != nil {
			actionErr = err
			break
		}
		found := false
		for _, invitation := range invitations {
			if invitation.InvitationID == op.Expansion.InvitationID && invitation.CanAcceptInvitation {
				found = true
				break
			}
		}
		if !found {
			actionErr = fmt.Errorf("invitation is no longer available")
			break
		}
		actionErr = lf.ActOnReceivedInvitation(ctx, op.Expansion.InvitationID, "accept")
	case "custom-champ-select-cancel":
		lobby, err := lf.FetchCurrentLobby(ctx)
		if err != nil || !containsTargetBytes(lobby, op.Expansion.CustomLobbyID) {
			if err != nil {
				actionErr = err
			} else {
				actionErr = fmt.Errorf("custom lobby changed")
			}
			break
		}
		actionErr = lf.CancelCustomChampSelect(ctx)
	case "loadout-rename", "loadout-delete":
		loadout, err := lf.FetchLoadout(ctx, op.Expansion.LoadoutID)
		if err != nil {
			actionErr = err
			break
		}
		if op.Kind == "loadout-delete" {
			actionErr = lf.DeleteLoadout(ctx, loadout.ID)
		} else {
			loadout.Name = op.Expansion.LoadoutName
			_, actionErr = lf.UpdateLoadout(ctx, loadout)
		}
	case "chat-mute-bulk":
		friends, err := lf.FetchLCUFriends(ctx)
		if err != nil {
			actionErr = err
			break
		}
		var friendValue any
		if json.Unmarshal(friends, &friendValue) != nil {
			actionErr = fmt.Errorf("friend list changed")
			break
		}
		for _, puuid := range op.Expansion.MutePUUIDs {
			if !containsJSONString(friendValue, puuid) {
				actionErr = fmt.Errorf("a selected friend is no longer present")
				break
			}
		}
		if actionErr == nil {
			actionErr = lf.UpdateChatMutes(ctx, op.Expansion.MutePUUIDs, op.Expansion.MuteValue)
		}
	default:
		actionErr = fmt.Errorf("unsupported reviewed expansion")
	}
	if actionErr == nil {
		result.Status = "succeeded"
		result.Detail = "League accepted the reviewed action"
	} else {
		result.Detail = "League rejected the reviewed action"
	}
	op.mu.Lock()
	op.Results = append(op.Results, result)
	op.Completed = len(op.Results)
	op.mu.Unlock()
	if actionErr != nil && mutationResultAmbiguous(actionErr) {
		finishOperation(op, false, "League returned an ambiguous mutation result; no retry was attempted")
		return
	}
	finishOperation(op, false, "")
}

func validateRewardSelections(grant riotclient.LCURewardGrant, selections []string) ([]string, error) {
	if len(selections) == 0 || len(selections) > 20 {
		return nil, fmt.Errorf("reward selection count changed")
	}
	available := make(map[string]bool, len(grant.RewardGroup.Rewards))
	for _, reward := range grant.RewardGroup.Rewards {
		available[reward.ID] = true
	}
	clean := make([]string, 0, len(selections))
	seen := make(map[string]struct{}, len(selections))
	for _, rawSelection := range selections {
		selection := strings.TrimSpace(rawSelection)
		if selection == "" || !available[selection] {
			return nil, fmt.Errorf("reward selection changed")
		}
		if _, exists := seen[selection]; exists {
			return nil, fmt.Errorf("reward selection count changed")
		}
		seen[selection] = struct{}{}
		clean = append(clean, selection)
	}
	config := grant.RewardGroup.SelectionStrategyConfig
	if config == nil {
		return clean, nil
	}
	if config.MinSelectionsAllowed > 0 && len(clean) < config.MinSelectionsAllowed {
		return nil, fmt.Errorf("reward selection count changed")
	}
	if config.MaxSelectionsAllowed > 0 && len(clean) > config.MaxSelectionsAllowed {
		return nil, fmt.Errorf("reward selection count changed")
	}
	return clean, nil
}

func expansionCancelled(op *reviewedOperation) bool {
	select {
	case <-op.Cancel:
		return true
	default:
		return false
	}
}

func containsTargetBytes(body []byte, target string) bool {
	var value any
	if json.Unmarshal(body, &value) != nil {
		return false
	}
	return containsTarget(value, target)
}

func operationTargetPresent(ctx context.Context, lf *riotclient.Lockfile, kind, target string, lootItem lootOperationItem) (bool, error) {
	var body []byte
	var err error
	if kind == "loot-craft" {
		body, err = lf.FetchLCULootRecipes(ctx, lootItem.LootID)
		if err != nil {
			return false, err
		}
		recipe, present := findLootRecipe(body, lootItem.RecipeName)
		if !present {
			return false, nil
		}
		inventory, inventoryErr := lf.FetchLCULoot(ctx)
		if inventoryErr != nil {
			return false, inventoryErr
		}
		return lootInputsAvailable(recipe, inventory, lootItem.LootIDs, lootItem.Repeat), nil
	} else if kind == "friend-remove" || kind == "friend-invite" {
		body, err = lf.FetchLCUFriends(ctx)
	} else {
		body, err = lf.FetchFriendRequests(ctx)
	}
	if err != nil {
		return false, err
	}
	var decoded any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return false, err
	}
	return containsTarget(decoded, target), nil
}

func mutationResultAmbiguous(err error) bool {
	if err == nil {
		return false
	}
	var lcuErr *riotclient.LCUError
	if !errors.As(err, &lcuErr) {
		return true
	}
	return lcuErr.StatusCode == http.StatusRequestTimeout || lcuErr.StatusCode == http.StatusTooManyRequests || lcuErr.StatusCode >= 500
}

func containsTarget(value any, target string) bool {
	switch current := value.(type) {
	case []any:
		for _, item := range current {
			if containsTarget(item, target) {
				return true
			}
		}
	case map[string]any:
		for _, key := range []string{"id", "pid", "summonerId", "jid", "lootId"} {
			if stringValue, ok := current[key].(string); ok && stringValue == target {
				return true
			}
			if number, ok := current[key].(float64); ok && fmt.Sprintf("%.0f", number) == target {
				return true
			}
		}
		for _, item := range current {
			if containsTarget(item, target) {
				return true
			}
		}
	}
	return false
}

func finishOperation(op *reviewedOperation, cancelled bool, detail string) {
	now := time.Now().UTC()
	op.mu.Lock()
	if cancelled {
		op.State = "cancelled"
	} else if detail != "" {
		op.State = "failed"
	} else if op.State != "failed" {
		op.State = "complete"
	}
	if detail != "" {
		op.Results = append(op.Results, featurestore.BatchItemResult{Status: "stopped", Detail: detail})
	}
	op.mu.Unlock()
	if featureData == nil {
		return
	}
	receipt := featurestore.BatchReceipt{ID: op.ID, Kind: op.Kind, CreatedAt: op.CreatedAt, CompletedAt: &now, Total: len(op.TargetIDs)}
	op.mu.Lock()
	receipt.Items = append([]featurestore.BatchItemResult(nil), op.Results...)
	for _, item := range receipt.Items {
		if item.Status == "succeeded" {
			receipt.Succeeded++
		}
		if item.Status == "failed" {
			receipt.Failed++
		}
	}
	receipt.Cancelled = cancelled || op.State == "cancelled"
	op.mu.Unlock()
	_ = featureData.Update(func(data *featurestore.Data) error {
		data.BatchReceipts = append(data.BatchReceipts, receipt)
		cutoff := time.Now().Add(-7 * 24 * time.Hour)
		filtered := data.BatchReceipts[:0]
		for _, candidate := range data.BatchReceipts {
			if candidate.CreatedAt.After(cutoff) {
				filtered = append(filtered, candidate)
			}
		}
		if len(filtered) > 20 {
			filtered = filtered[len(filtered)-20:]
		}
		data.BatchReceipts = filtered
		return nil
	})
}
