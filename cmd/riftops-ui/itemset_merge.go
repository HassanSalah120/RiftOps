package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type managedItemSetItem struct {
	ID    string `json:"id"`
	Count int    `json:"count"`
}

type managedItemSetBlock struct {
	Type  string               `json:"type"`
	Items []managedItemSetItem `json:"items"`
}

type managedItemSetSpec struct {
	Name        string                `json:"name"`
	ChampionIDs []string              `json:"championIds"`
	Mode        string                `json:"mode"`
	Map         string                `json:"map"`
	Blocks      []managedItemSetBlock `json:"blocks"`
}

func mergeManagedItemSet(current []byte, spec managedItemSetSpec) (json.RawMessage, map[string]any, error) {
	spec.Name = strings.TrimSpace(spec.Name)
	if spec.Name == "" || len([]rune(spec.Name)) > 48 || len(spec.ChampionIDs) > 32 || len(spec.Blocks) == 0 || len(spec.Blocks) > 20 || len(spec.Mode) > 40 || len(spec.Map) > 40 {
		return nil, nil, fmt.Errorf("managed item-set fields are invalid")
	}
	for _, championID := range spec.ChampionIDs {
		parsed, err := strconv.Atoi(strings.TrimSpace(championID))
		if err != nil || parsed <= 0 {
			return nil, nil, fmt.Errorf("champion ids must be positive integers")
		}
	}
	for _, block := range spec.Blocks {
		if strings.TrimSpace(block.Type) == "" || len([]rune(block.Type)) > 48 || len(block.Items) == 0 || len(block.Items) > 60 {
			return nil, nil, fmt.Errorf("managed item-set block is invalid")
		}
		for _, item := range block.Items {
			parsed, err := strconv.Atoi(strings.TrimSpace(item.ID))
			if err != nil || parsed <= 0 || item.Count <= 0 || item.Count > 6 {
				return nil, nil, fmt.Errorf("managed item-set item is invalid")
			}
		}
	}
	var wrapper map[string]any
	if err := json.Unmarshal(current, &wrapper); err != nil {
		return nil, nil, fmt.Errorf("League returned an invalid item-set document")
	}
	rawSets, present := wrapper["itemSets"]
	sets, ok := rawSets.([]any)
	if !present || !ok {
		return nil, nil, fmt.Errorf("League returned an unexpected item-set document")
	}
	identity, _ := json.Marshal(struct {
		Name        string   `json:"name"`
		ChampionIDs []string `json:"championIds"`
		Mode        string   `json:"mode"`
		Map         string   `json:"map"`
	}{spec.Name, spec.ChampionIDs, spec.Mode, spec.Map})
	identityHash := sha256.Sum256(identity)
	managed := map[string]any{
		"uid": "riftops-" + hex.EncodeToString(identityHash[:8]), "name": "RiftOps: " + spec.Name,
		"championIds": spec.ChampionIDs, "mode": spec.Mode, "map": spec.Map, "blocks": spec.Blocks, "type": "custom",
	}
	replaced := false
	for index, existing := range sets {
		if existingMap, ok := existing.(map[string]any); ok && existingMap["uid"] == managed["uid"] {
			sets[index], replaced = managed, true
			break
		}
	}
	if !replaced {
		sets = append(sets, managed)
	}
	wrapper["itemSets"] = sets
	encoded, err := json.Marshal(wrapper)
	if err != nil {
		return nil, nil, fmt.Errorf("could not encode the managed item set")
	}
	return encoded, managed, nil
}
