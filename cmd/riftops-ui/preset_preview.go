package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type presetPreviewGrant struct {
	ID         string
	Kind       string
	PresetID   string
	AccountKey string
	ExpiresAt  time.Time
}

var presetPreviewGrants = struct {
	sync.Mutex
	items map[string]presetPreviewGrant
}{items: make(map[string]presetPreviewGrant)}

func newPresetPreview(kind, presetID, accountKey string) presetPreviewGrant {
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	grant := presetPreviewGrant{ID: "preview-" + hex.EncodeToString(buffer), Kind: kind, PresetID: presetID, AccountKey: accountKey, ExpiresAt: time.Now().Add(2 * time.Minute).UTC()}
	presetPreviewGrants.Lock()
	for id, existing := range presetPreviewGrants.items {
		if time.Now().After(existing.ExpiresAt) {
			delete(presetPreviewGrants.items, id)
		}
	}
	presetPreviewGrants.items[grant.ID] = grant
	presetPreviewGrants.Unlock()
	return grant
}

func consumePresetPreview(id, kind, presetID, accountKey string) bool {
	presetPreviewGrants.Lock()
	defer presetPreviewGrants.Unlock()
	grant, ok := presetPreviewGrants.items[id]
	if !ok || time.Now().After(grant.ExpiresAt) || grant.Kind != kind || grant.PresetID != presetID || grant.AccountKey != accountKey {
		return false
	}
	delete(presetPreviewGrants.items, id)
	return true
}
