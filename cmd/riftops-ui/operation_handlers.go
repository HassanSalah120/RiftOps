package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
		Kind      string   `json:"kind"`
		TargetIDs []string `json:"targetIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "Invalid operation preview", http.StatusBadRequest)
		return
	}
	body.Kind = strings.ToLower(strings.TrimSpace(body.Kind))
	if body.Kind != "friend-remove" && body.Kind != "friend-invite" && body.Kind != "request-accept" && body.Kind != "request-decline" {
		httpError(w, "Unsupported reviewed operation", http.StatusBadRequest)
		return
	}
	if len(body.TargetIDs) == 0 || len(body.TargetIDs) > 100 {
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
	verb := map[string]string{"friend-remove": "REMOVE", "friend-invite": "INVITE", "request-accept": "ACCEPT", "request-decline": "DECLINE"}[body.Kind]
	op := &reviewedOperation{ID: operationID(), Kind: body.Kind, TargetIDs: clean, Confirmation: fmt.Sprintf("%s %d %s", verb, len(clean), map[string]string{"friend-remove": "FRIENDS", "friend-invite": "FRIENDS", "request-accept": "REQUESTS", "request-decline": "REQUESTS"}[body.Kind]), State: "preview", CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(2 * time.Minute).UTC(), Cancel: make(chan struct{})}
	reviewedOperations.Lock()
	reviewedOperations.items[op.ID] = op
	reviewedOperations.Unlock()
	writeSafeJSON(w, map[string]any{"id": op.ID, "kind": op.Kind, "targetIds": op.TargetIDs, "confirmation": op.Confirmation, "expiresAt": op.ExpiresAt, "state": op.State})
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
	for _, target := range op.TargetIDs {
		select {
		case <-op.Cancel:
			finishOperation(op, true, "Cancelled by user")
			return
		default:
		}
		present, err := operationTargetPresent(ctx, lf, op.Kind, target)
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
			}
			if actionErr != nil {
				result.Status, result.Detail = "failed", "League rejected this target"
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
		case <-time.After(250 * time.Millisecond):
		}
	}
	finishOperation(op, false, "")
}

func operationTargetPresent(ctx context.Context, lf *riotclient.Lockfile, kind, target string) (bool, error) {
	var body []byte
	var err error
	if kind == "friend-remove" || kind == "friend-invite" {
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

func containsTarget(value any, target string) bool {
	switch current := value.(type) {
	case []any:
		for _, item := range current {
			if containsTarget(item, target) {
				return true
			}
		}
	case map[string]any:
		for _, key := range []string{"id", "pid", "summonerId", "jid"} {
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
