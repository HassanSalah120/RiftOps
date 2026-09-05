package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

type availableQueue struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	GameMode string `json:"gameMode,omitempty"`
	Category string `json:"category,omitempty"`
	MapID    int    `json:"mapId,omitempty"`
}

func findAvailableQueue(ctx context.Context, lf *riotclient.Lockfile, queueID int) (availableQueue, error) {
	body, err := lf.FetchAvailableQueues(ctx)
	if err != nil {
		return availableQueue{}, err
	}
	var queues []availableQueue
	if err := json.Unmarshal(body, &queues); err != nil {
		return availableQueue{}, fmt.Errorf("League returned an invalid queue catalogue")
	}
	for _, queue := range queues {
		if queue.ID == queueID {
			return queue, nil
		}
	}
	return availableQueue{}, fmt.Errorf("queue is unavailable for this League patch")
}

func createAvailableQueueLobby(ctx context.Context, lf *riotclient.Lockfile, queue availableQueue) error {
	if strings.EqualFold(queue.Category, "custom") {
		return lf.CreateCustomLobby(ctx, queue.ID, queue.GameMode, queue.Name, queue.MapID)
	}
	return lf.CreateQueueLobby(ctx, queue.ID)
}
