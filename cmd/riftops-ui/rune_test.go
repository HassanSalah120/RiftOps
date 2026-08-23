package main

import "testing"

func TestValidatedRunePagePayload(t *testing.T) {
	payload := map[string]any{
		"id":              float64(42),
		"name":            "  Ahri mid  ",
		"primaryStyleId":  float64(8100),
		"subStyleId":      float64(8200),
		"selectedPerkIds": []any{float64(8112), float64(8126), float64(8138), float64(8135), float64(8210), float64(8237), float64(5008), float64(5008), float64(5001)},
		"isActive":        true,
	}
	clean, err := validatedRunePagePayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	if clean["name"] != "Ahri mid" {
		t.Fatalf("clean rune page name = %q", clean["name"])
	}
	if _, exists := clean["isActive"]; exists {
		t.Fatal("client-only fields must not be forwarded to LCU")
	}
	if ids, ok := clean["selectedPerkIds"].([]int); !ok || len(ids) != 9 {
		t.Fatalf("clean selected perks = %#v", clean["selectedPerkIds"])
	}
}

func TestValidatedRunePagePayloadRejectsMalformedPages(t *testing.T) {
	valid := map[string]any{
		"name":            "Ahri",
		"primaryStyleId":  float64(8100),
		"subStyleId":      float64(8200),
		"selectedPerkIds": []any{float64(1), float64(2), float64(3), float64(4), float64(5), float64(6), float64(7), float64(8), float64(9)},
	}
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "missing perk", mutate: func(page map[string]any) { page["selectedPerkIds"] = page["selectedPerkIds"].([]any)[:8] }},
		{name: "same styles", mutate: func(page map[string]any) { page["subStyleId"] = float64(8100) }},
		{name: "empty name", mutate: func(page map[string]any) { page["name"] = "  " }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			page := make(map[string]any, len(valid))
			for key, value := range valid {
				page[key] = value
			}
			test.mutate(page)
			if _, err := validatedRunePagePayload(page); err == nil {
				t.Fatal("expected malformed rune page to be rejected")
			}
		})
	}
}
