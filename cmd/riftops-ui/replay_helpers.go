package main

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

type replayStatusResponse struct {
	GameID      int64   `json:"gameId"`
	Status      string  `json:"status"`
	Progress    float64 `json:"progress,omitempty"`
	LeagueState string  `json:"leagueState,omitempty"`
	Error       string  `json:"error,omitempty"`
}

func normalizeReplayMetadata(gameID string, body []byte) (replayStatusResponse, bool) {
	parsedID, _ := strconv.ParseInt(gameID, 10, 64)
	var payload struct {
		GameID           int64   `json:"gameId"`
		State            string  `json:"state"`
		DownloadProgress float64 `json:"downloadProgress"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return replayStatusResponse{GameID: parsedID, Status: "failed", Error: "League returned malformed replay metadata"}, false
	}
	if payload.GameID > 0 {
		parsedID = payload.GameID
	}
	state := strings.ToLower(strings.TrimSpace(payload.State))
	status := map[string]string{"watch": "ready", "downloading": "downloading", "download": "available", "found": "available", "checking": "available", "incompatible": "expired"}[state]
	if status == "" {
		status = "failed"
	}
	progress := payload.DownloadProgress
	if status != "downloading" || math.IsNaN(progress) || math.IsInf(progress, 0) || progress < 0 {
		progress = 0
	}
	if progress >= 0 && progress <= 1 {
		progress *= 100
	}
	if progress > 100 {
		progress = 0
	}
	return replayStatusResponse{GameID: parsedID, Status: status, Progress: progress, LeagueState: state}, status != "failed"
}
