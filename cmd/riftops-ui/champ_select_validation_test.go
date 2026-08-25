//go:build desktop

package main

import "testing"

func TestValidateChampSelectActionPayloadAcceptsCurrentAction(t *testing.T) {
	body := []byte(`{"actions":[[{"id":0,"championId":0,"type":"pick","completed":false},{"id":1,"championId":103,"type":"ban","completed":false}]]}`)
	if err := validateChampSelectActionPayload(body, 0, 84); err != nil {
		t.Fatalf("current action was rejected: %v", err)
	}
}

func TestValidateChampSelectActionPayloadRejectsStaleAndOccupiedActions(t *testing.T) {
	body := []byte(`{"actions":[[{"id":4,"championId":103,"type":"pick","completed":false},{"id":5,"championId":84,"type":"ban","completed":true},{"id":6,"championId":84,"type":"pick","completed":false}]]}`)
	if err := validateChampSelectActionPayload(body, 9, 84); err == nil {
		t.Fatal("missing action was accepted")
	}
	if err := validateChampSelectActionPayload(body, 4, 84); err == nil {
		t.Fatal("occupied champion was accepted")
	}
	if err := validateChampSelectActionPayload(body, 5, 84); err == nil {
		t.Fatal("completed action was accepted")
	}
}

func TestValidateChampSelectActionPayloadDoesNotBlockUnknownShapes(t *testing.T) {
	if err := validateChampSelectActionPayload([]byte(`{"unexpected":true}`), 4, 84); err != nil {
		t.Fatalf("unknown session shape should remain LCU-authoritative: %v", err)
	}
}

func TestValidateChampSelectActionPayloadAllowsArenaBraveryPick(t *testing.T) {
	body := []byte(`{"actions":[[{"id":12,"championId":0,"type":"pick","completed":false}]]}`)
	if err := validateChampSelectActionPayload(body, 12, -3); err != nil {
		t.Fatalf("Arena Bravery pick was rejected: %v", err)
	}
}

func TestValidateChampSelectActionPayloadRejectsArenaBraveryBan(t *testing.T) {
	body := []byte(`{"actions":[[{"id":12,"championId":0,"type":"ban","completed":false}]]}`)
	if err := validateChampSelectActionPayload(body, 12, -3); err == nil {
		t.Fatal("Arena Bravery was accepted for a ban action")
	}
}
