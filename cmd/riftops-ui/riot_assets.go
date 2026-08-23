package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type profileBackgroundSkin struct {
	ID               int    `json:"id"`
	Name             string `json:"name"`
	PreviewAssetPath string `json:"previewAssetPath,omitempty"`
	SplashAssetPath  string `json:"splashAssetPath,omitempty"`
}

func jsonNumber(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case json.Number:
		parsed, _ := number.Int64()
		return int(parsed)
	case int:
		return number
	case string:
		var parsed int
		_, _ = fmt.Sscanf(number, "%d", &parsed)
		return parsed
	default:
		return 0
	}
}

func validLCUAssetPath(value any) string {
	path, ok := value.(string)
	if !ok {
		return ""
	}
	path = strings.TrimSpace(strings.ReplaceAll(path, `\`, "/"))
	if !strings.HasPrefix(strings.ToLower(path), "/lol-game-data/assets/") || strings.Contains(path, "..") {
		return ""
	}
	return path
}

func collectSkinObjects(value any, result *[]map[string]any) {
	switch current := value.(type) {
	case []any:
		for _, entry := range current {
			collectSkinObjects(entry, result)
		}
	case map[string]any:
		id := jsonNumber(current["id"])
		if id == 0 {
			id = jsonNumber(current["skinId"])
		}
		if id > 0 && (current["name"] != nil || current["splashPath"] != nil || current["uncenteredSplashPath"] != nil) {
			*result = append(*result, current)
			return
		}
		for _, key := range []string{"skins", "championSkins", "items", "data"} {
			if child, exists := current[key]; exists {
				collectSkinObjects(child, result)
			}
		}
	}
}

func decodeSkinObjects(body []byte) ([]map[string]any, error) {
	if len(body) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var result []map[string]any
	if object, ok := value.(map[string]any); ok {
		// Static skins.json is keyed by skin ID rather than wrapped in `data`.
		for _, entry := range object {
			collectSkinObjects(entry, &result)
		}
	} else {
		collectSkinObjects(value, &result)
	}
	return result, nil
}

func buildProfileBackgroundSkins(inventoryJSON, catalogueJSON []byte) ([]profileBackgroundSkin, error) {
	inventory, err := decodeSkinObjects(inventoryJSON)
	if err != nil {
		return nil, fmt.Errorf("decode champion skin inventory: %w", err)
	}
	catalogue, err := decodeSkinObjects(catalogueJSON)
	if err != nil {
		return nil, fmt.Errorf("decode skin asset catalogue: %w", err)
	}
	metadata := make(map[int]map[string]any, len(catalogue))
	for _, entry := range catalogue {
		id := jsonNumber(entry["id"])
		if id > 0 {
			metadata[id] = entry
		}
	}

	seen := make(map[int]bool, len(inventory))
	result := make([]profileBackgroundSkin, 0, len(inventory))
	for _, entry := range inventory {
		id := jsonNumber(entry["id"])
		if id == 0 {
			id = jsonNumber(entry["skinId"])
		}
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		asset := metadata[id]
		name, _ := entry["name"].(string)
		if strings.TrimSpace(name) == "" {
			name, _ = asset["name"].(string)
		}
		if strings.TrimSpace(name) == "" {
			name = fmt.Sprintf("Skin %d", id)
		}
		preview := validLCUAssetPath(entry["uncenteredSplashPath"])
		if preview == "" {
			preview = validLCUAssetPath(asset["uncenteredSplashPath"])
		}
		splash := validLCUAssetPath(entry["splashPath"])
		if splash == "" {
			splash = validLCUAssetPath(asset["splashPath"])
		}
		if preview == "" {
			preview = splash
		}
		result = append(result, profileBackgroundSkin{
			ID:               id,
			Name:             strings.TrimSpace(name),
			PreviewAssetPath: preview,
			SplashAssetPath:  splash,
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}
