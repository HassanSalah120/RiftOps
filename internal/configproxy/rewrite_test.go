package configproxy

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestRewrite(t *testing.T) {
	input := []byte(`{"chat.host":"fallback.riot.test","chat.port":5223,"use_tls":{"enabled":true},"chat.affinity.enabled":true,"chat.affinities":{"eu":"eu.riot.test","na":"na.riot.test"},"untouched":true}`)
	modified, endpoint, err := Rewrite(input, RewriteOptions{LocalHost: "riftops.test", LocalPort: 12345, Affinity: "eu"})
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.Host != "eu.riot.test" || endpoint.Port != 5223 {
		t.Fatalf("endpoint = %+v", endpoint)
	}
	var got map[string]any
	if err := json.Unmarshal(modified, &got); err != nil {
		t.Fatal(err)
	}
	if got["chat.host"] != "riftops.test" || got["chat.port"] != float64(12345) || got["untouched"] != true {
		t.Fatalf("modified config = %s", modified)
	}
	if useTLS, ok := got["use_tls"].(map[string]any); !ok || useTLS["enabled"] != true {
		t.Fatalf("Riot chat TLS setting was not preserved: %s", modified)
	}
	for key, host := range got["chat.affinities"].(map[string]any) {
		if host != "riftops.test" {
			t.Errorf("affinity %s = %v", key, host)
		}
	}
}

func TestAffinityFromJWT(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"affinity":"na"}`))
	got, err := AffinityFromJWT("header." + payload + ".signature")
	if err != nil || got != "na" {
		t.Fatalf("affinity = %q, err=%v", got, err)
	}
}

func TestRewritePassesThroughConfigWithoutCompleteChatEndpoint(t *testing.T) {
	tests := [][]byte{
		[]byte(`{"keystone.enabled":true,"region":"EUW"}`),
		[]byte(`{"chat.host":"chat.example.test","unrelated":true}`),
		[]byte(`{"chat.port":5223,"unrelated":true}`),
	}
	for _, input := range tests {
		modified, endpoint, err := Rewrite(input, RewriteOptions{LocalHost: "riftops.test", LocalPort: 12345})
		if err != nil {
			t.Fatal(err)
		}
		if endpoint.Valid() {
			t.Fatalf("unexpected endpoint for %s: %+v", input, endpoint)
		}
		if string(modified) != string(input) {
			t.Fatalf("pass-through changed body: got %s, want %s", modified, input)
		}
	}
}

func TestRewriteUsesAffinityWhenChatHostIsOmitted(t *testing.T) {
	input := []byte(`{"chat.port":5223,"chat.affinity.enabled":true,"chat.affinities":{"eu":"eu.test","na":"na.test"}}`)
	modified, endpoint, err := Rewrite(input, RewriteOptions{LocalHost: "127.0.0.1", LocalPort: 4567, Affinity: "na"})
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.Host != "na.test" || endpoint.Port != 5223 {
		t.Fatalf("endpoint = %+v, want affinity host and original port", endpoint)
	}
	var got map[string]any
	if err := json.Unmarshal(modified, &got); err != nil {
		t.Fatal(err)
	}
	if got["chat.host"] != "127.0.0.1" || got["chat.port"] != float64(4567) {
		t.Fatalf("modified config = %s", modified)
	}
}
