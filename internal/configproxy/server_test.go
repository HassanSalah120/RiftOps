package configproxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestServerRewritesAndPublishesEndpoint(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"affinity":"eu"}`))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/pas" {
			_, _ = io.WriteString(w, "header."+payload+".signature")
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("authorization was not forwarded")
		}
		_, _ = io.WriteString(w, `{"chat.host":"fallback.test","chat.port":5223,"chat.affinity.enabled":true,"chat.affinities":{"eu":"eu.test"}}`)
	}))
	defer upstream.Close()

	server, err := NewServer(ServerOptions{
		LocalChatHost: "localhost.test", LocalChatPort: 4567,
		Upstream: upstream.URL, GeoPAS: upstream.URL + "/pas",
	})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Run() }()
	defer server.Close(context.Background())

	request, _ := http.NewRequest(http.MethodGet, server.URL()+"/config?x=1", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var config map[string]any
	if err := json.NewDecoder(response.Body).Decode(&config); err != nil {
		t.Fatal(err)
	}
	if config["chat.host"] != "localhost.test" || config["chat.port"] != float64(4567) {
		t.Fatalf("rewritten config = %#v", config)
	}
	select {
	case endpoint := <-server.Endpoints():
		if endpoint.Host != "eu.test" || endpoint.Port != 5223 {
			t.Fatalf("endpoint = %+v", endpoint)
		}
	case <-time.After(time.Second):
		t.Fatal("endpoint was not published")
	}
}

func TestServerPassesThroughSuccessfulNonChatConfig(t *testing.T) {
	const body = `{"keystone.enabled":true,"region":"EUW"}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, body)
	}))
	defer upstream.Close()

	server, err := NewServer(ServerOptions{LocalChatHost: "localhost.test", LocalChatPort: 4567, Upstream: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Run() }()
	defer server.Close(context.Background())

	response, err := http.Get(server.URL() + "/keystone/config")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	got, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(got) != body {
		t.Fatalf("status/body = %d %s", response.StatusCode, got)
	}
	select {
	case endpoint := <-server.Endpoints():
		t.Fatalf("unexpected endpoint: %+v", endpoint)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestServerPassThroughChatPreservesRiotEndpoint(t *testing.T) {
	const body = `{"chat.host":"eun1.chat.si.riotgames.com","chat.port":5223,"chat.affinities":{"eun1":"eun1.chat.si.riotgames.com"}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, body)
	}))
	defer upstream.Close()

	server, err := NewServer(ServerOptions{PassThroughChat: true, Upstream: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Run() }()
	defer server.Close(context.Background())

	response, err := http.Get(server.URL() + "/api/v1/config/player")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	got, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("chat config changed: %s", got)
	}
	select {
	case endpoint := <-server.Endpoints():
		t.Fatalf("unexpected rewritten endpoint: %+v", endpoint)
	case <-time.After(50 * time.Millisecond):
	}
}
