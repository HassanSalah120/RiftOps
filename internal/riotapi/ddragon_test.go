package riotapi

import (
	"encoding/json"
	"testing"
)

func TestProfileIconListAcceptsNumericAndStringIDs(t *testing.T) {
	var icons ProfileIconList
	if err := json.Unmarshal([]byte(`{"data":{"numeric":{"id":0},"string":{"id":"50"}}}`), &icons); err != nil {
		t.Fatalf("decode mixed profile icon IDs: %v", err)
	}
	if got := int(icons.Data["numeric"].ID); got != 0 {
		t.Fatalf("numeric ID = %d, want 0", got)
	}
	if got := int(icons.Data["string"].ID); got != 50 {
		t.Fatalf("string ID = %d, want 50", got)
	}
}

func TestProfileIconListRejectsInvalidStringID(t *testing.T) {
	var icons ProfileIconList
	if err := json.Unmarshal([]byte(`{"data":{"invalid":{"id":"not-a-number"}}}`), &icons); err == nil {
		t.Fatal("expected invalid profile icon ID to fail decoding")
	}
}
