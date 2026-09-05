//go:build desktop

package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestMergeManagedItemSetPreservesUnrelatedDocumentData(t *testing.T) {
	current := []byte(`{"accountId":77,"itemSets":[{"uid":"third-party","name":"Community build","blocks":[{"type":"Core","items":[{"id":"1001","count":1}]}]}],"unknown":{"keep":true}}`)
	spec := managedItemSetSpec{Name: "Ahri mid", ChampionIDs: []string{"103"}, Mode: "CLASSIC", Map: "11", Blocks: []managedItemSetBlock{{Type: "Planned build", Items: []managedItemSetItem{{ID: "6655", Count: 1}}}}}
	merged, managed, err := mergeManagedItemSet(current, spec)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	_ = json.Unmarshal(current, &before)
	_ = json.Unmarshal(merged, &after)
	if !reflect.DeepEqual(before["unknown"], after["unknown"]) || before["accountId"] != after["accountId"] {
		t.Fatalf("unrelated document fields changed: %s", merged)
	}
	sets := after["itemSets"].([]any)
	if len(sets) != 2 || !reflect.DeepEqual(sets[0], before["itemSets"].([]any)[0]) || managed["name"] != "RiftOps: Ahri mid" {
		t.Fatalf("unrelated set was not preserved: %s", merged)
	}
	updatedSpec := spec
	updatedSpec.Blocks[0].Items[0].ID = "3089"
	updated, _, err := mergeManagedItemSet(merged, updatedSpec)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(updated, &after)
	if len(after["itemSets"].([]any)) != 2 {
		t.Fatalf("stable managed id created a duplicate: %s", updated)
	}
}

func TestMergeManagedItemSetFailsClosedOnChangedShapeOrInvalidItems(t *testing.T) {
	valid := managedItemSetSpec{Name: "Build", ChampionIDs: []string{"1"}, Blocks: []managedItemSetBlock{{Type: "Core", Items: []managedItemSetItem{{ID: "1001", Count: 1}}}}}
	if _, _, err := mergeManagedItemSet([]byte(`{"itemSets":{}}`), valid); err == nil {
		t.Fatal("changed League document shape was accepted")
	}
	valid.Blocks[0].Items[0].ID = "not-an-item"
	if _, _, err := mergeManagedItemSet([]byte(`{"itemSets":[]}`), valid); err == nil {
		t.Fatal("invalid item id was accepted")
	}
}
