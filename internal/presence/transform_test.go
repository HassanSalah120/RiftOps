package presence

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/model"
)

func fullPresence() string {
	valorant := base64.StdEncoding.EncodeToString([]byte(`{"partyPresenceData":{"partyClientVersion":"release-10.0"}}`))
	return "<presence><show>chat</show><status>secret</status><games>" +
		"<league_of_legends><st>chat</st><p>party</p><m>map</m></league_of_legends>" +
		"<valorant><p>" + valorant + "</p></valorant><bacon/><lion/><keystone/><riot_client/>" +
		"</games></presence>"
}

func TestOfflineRemovesGamePresence(t *testing.T) {
	result, err := Transform([]byte(fullPresence()), Options{Status: model.StatusOffline, ConnectToMUC: true})
	if err != nil {
		t.Fatal(err)
	}
	output := string(result.Raw)
	for _, forbidden := range []string{"<status", "league_of_legends", "valorant", "bacon", "lion", "keystone", "riot_client", "secret"} {
		if strings.Contains(output, forbidden) {
			t.Errorf("offline output still contains %q: %s", forbidden, output)
		}
	}
	if !strings.Contains(output, "<show>offline</show>") {
		t.Errorf("offline output has wrong show: %s", output)
	}
	if result.ValorantVersion != "release-10.0" {
		t.Errorf("version = %q", result.ValorantVersion)
	}
}

func TestMobileKeepsReducedLeaguePresence(t *testing.T) {
	result, err := Transform([]byte(fullPresence()), Options{Status: model.StatusMobile, ConnectToMUC: true})
	if err != nil {
		t.Fatal(err)
	}
	output := string(result.Raw)
	if !strings.Contains(output, "league_of_legends") || !strings.Contains(output, "<st>mobile</st>") {
		t.Errorf("mobile output lost league state: %s", output)
	}
	if strings.Contains(output, "<p>") || strings.Contains(output, "<m>") || strings.Contains(output, "valorant") {
		t.Errorf("mobile output leaked rich presence: %s", output)
	}
}

func TestDirectedPresencePolicy(t *testing.T) {
	raw := []byte("<presence to='room@example.test'><show>chat</show></presence>")
	keep, err := Transform(raw, Options{Status: model.StatusOffline, ConnectToMUC: true})
	if err != nil || string(keep.Raw) != string(raw) || keep.Drop {
		t.Fatalf("keep = %+v, err=%v", keep, err)
	}
	drop, err := Transform(raw, Options{Status: model.StatusOffline, ConnectToMUC: false})
	if err != nil || !drop.Drop {
		t.Fatalf("drop = %+v, err=%v", drop, err)
	}
}

func TestOnlinePreservesDND(t *testing.T) {
	raw := []byte("<presence><show>dnd</show><games><league_of_legends><st>dnd</st></league_of_legends></games></presence>")
	result, err := Transform(raw, Options{Status: model.StatusOnline})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result.Raw), "<show>dnd</show>") || !strings.Contains(string(result.Raw), "<st>dnd</st>") {
		t.Errorf("DND was not preserved: %s", result.Raw)
	}
}
