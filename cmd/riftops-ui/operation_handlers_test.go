package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetReviewedOperationsForTest() {
	reviewedOperations.Lock()
	reviewedOperations.items = make(map[string]*reviewedOperation)
	reviewedOperations.Unlock()
}

func operationRequest(method, path string, body any) *http.Request {
	encoded, _ := json.Marshal(body)
	return httptest.NewRequest(method, path, bytes.NewReader(encoded))
}

func TestOperationPreviewEnforcesInviteLimit(t *testing.T) {
	resetReviewedOperationsForTest()
	targets := make([]string, 21)
	for index := range targets {
		targets[index] = "100" + strings.Repeat("0", index%3) + string(rune('1'+index))
	}
	recorder := httptest.NewRecorder()
	operationPreviewHandler(recorder, operationRequest(http.MethodPost, "/api/operations/preview", map[string]any{
		"kind": "friend-invite", "targetIds": targets,
	}))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invite preview returned %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestOperationPreviewExpiresBeforeExecution(t *testing.T) {
	resetReviewedOperationsForTest()
	previewRecorder := httptest.NewRecorder()
	operationPreviewHandler(previewRecorder, operationRequest(http.MethodPost, "/api/operations/preview", map[string]any{
		"kind": "friend-remove", "targetIds": []string{"77"},
	}))
	if previewRecorder.Code != http.StatusOK {
		t.Fatalf("preview returned %d: %s", previewRecorder.Code, previewRecorder.Body.String())
	}
	var preview struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(previewRecorder.Body.Bytes(), &preview); err != nil || preview.ID == "" {
		t.Fatalf("invalid preview response: %s", previewRecorder.Body.String())
	}
	op := lookupOperation(preview.ID)
	if op == nil {
		t.Fatal("preview was not retained")
	}
	op.mu.Lock()
	op.ExpiresAt = time.Now().Add(-time.Second)
	op.mu.Unlock()
	executeRecorder := httptest.NewRecorder()
	operationExecuteHandler(executeRecorder, operationRequest(http.MethodPost, "/api/operations/execute", map[string]any{
		"id": preview.ID, "confirmation": op.Confirmation,
	}))
	if executeRecorder.Code != http.StatusConflict {
		t.Fatalf("expired operation returned %d, want %d", executeRecorder.Code, http.StatusConflict)
	}
	op.mu.Lock()
	state := op.State
	op.mu.Unlock()
	if state != "expired" {
		t.Fatalf("expired operation state = %q", state)
	}
}

func TestOperationRemoteRequestsAreDesktopOnly(t *testing.T) {
	resetReviewedOperationsForTest()
	recorder := httptest.NewRecorder()
	request := operationRequest(http.MethodPost, "/api/operations/preview", map[string]any{
		"kind": "friend-remove", "targetIds": []string{"77"},
	})
	request = request.WithContext(context.WithValue(request.Context(), remoteRequestKey{}, true))
	operationPreviewHandler(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("remote operation preview returned %d, want %d", recorder.Code, http.StatusForbidden)
	}
}
