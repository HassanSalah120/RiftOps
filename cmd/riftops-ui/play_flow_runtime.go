//go:build desktop

package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/HassanSalah120/RiftOps/internal/playflow"
	"github.com/HassanSalah120/RiftOps/internal/qol"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

var playFlowRuntime *playflow.Service

func initPlayFlowRuntime() {
	playFlowRuntime = playflow.New(
		func() playflow.Client {
			lockfile := riotclient.GetLCULockfile()
			if lockfile == nil {
				return nil
			}
			return lockfile
		},
		func() qol.PlayFlowPreferences {
			preferences := qol.DefaultPlayFlowPreferences()
			if qolManager == nil {
				return preferences
			}
			stored := qolManager.Preferences()
			if stored.PlayFlow != nil {
				return *stored.PlayFlow
			}
			return preferences
		},
	)
	if qolManager != nil {
		playFlowRuntime.SetActiveChangeHook(qolManager.SetPlayFlowRuntimeActive)
	}
}

func playFlowRuntimeStatusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if playFlowRuntime == nil {
		initPlayFlowRuntime()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(playFlowRuntime.Status())
}

func playFlowRuntimeStartHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if remoteRequest(r) {
		httpError(w, "Full Auto can only be started from the RiftOps desktop app", http.StatusForbidden)
		return
	}
	var body struct {
		CycleMode playflow.CycleMode `json:"cycleMode"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		httpError(w, "Invalid Full Auto request", http.StatusBadRequest)
		return
	}
	if playFlowRuntime == nil {
		initPlayFlowRuntime()
	}
	status, err := playFlowRuntime.Start(body.CycleMode)
	if err != nil {
		switch {
		case errors.Is(err, playflow.ErrAlreadyActive):
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(status)
		case errors.Is(err, playflow.ErrInvalidCycle):
			httpError(w, err.Error(), http.StatusBadRequest)
		default:
			httpError(w, "Full Auto settings are invalid", http.StatusBadRequest)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func playFlowRuntimeStopHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if remoteRequest(r) {
		httpError(w, "Full Auto can only be stopped from the RiftOps desktop app", http.StatusForbidden)
		return
	}
	if playFlowRuntime == nil {
		initPlayFlowRuntime()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(playFlowRuntime.Stop())
}
