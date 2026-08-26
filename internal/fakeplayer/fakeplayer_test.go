package fakeplayer

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestParseCommandUsesMessageBody(t *testing.T) {
	raw := []byte("<message to='" + JID + "/RC'><body>offline</body><other>online</other></message>")
	command, handled, err := ParseCommand(raw)
	if err != nil || !handled || command != CommandOffline {
		t.Fatalf("command=%q handled=%v err=%v", command, handled, err)
	}
}

func TestInjectRoster(t *testing.T) {
	raw := []byte("<iq from='server'><query xmlns='jabber:iq:riotgames:roster'><item jid='someone@test'/></query></iq>")
	result, inserted, err := InjectRoster(raw)
	if err != nil || !inserted || !strings.Contains(string(result), JID) {
		t.Fatalf("inserted=%v err=%v result=%s", inserted, err, result)
	}
	// Verify the original content is preserved alongside the new item
	if !strings.Contains(string(result), "someone@test") {
		t.Fatalf("original roster item missing:\n%s", result)
	}
	// Verify idempotency — second call should not insert another copy
	result2, inserted2, err2 := InjectRoster(result)
	if err2 != nil || inserted2 {
		t.Fatalf("second insert: inserted=%v err=%v", inserted2, err2)
	}
	if string(result2) != string(result) {
		t.Fatalf("idempotent re-encode changed output:\nbefore=%s\nafter=%s", result, result2)
	}
}

func TestInjectRosterPreservesRiotPayloadBytes(t *testing.T) {
	raw := []byte(`<iq id='roster-1' from='server'><r:query xmlns:r='jabber:iq:riotgames:roster'><item jid='friend@test' subscription='both'><lol><p><![CDATA[{"rank":"GOLD","note":"a>b"}]]></p></lol></item><!--riot-marker--></r:query></iq>`)
	closing := bytes.Index(raw, []byte("</r:query>"))
	if closing < 0 {
		t.Fatal("invalid test fixture")
	}
	want := make([]byte, 0, len(raw)+len(rosterItemXML))
	want = append(want, raw[:closing]...)
	want = append(want, rosterItemXML...)
	want = append(want, raw[closing:]...)

	got, inserted, err := InjectRoster(raw)
	if err != nil || !inserted {
		t.Fatalf("inserted=%v err=%v", inserted, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("roster bytes changed outside the insertion\nwant: %s\n got: %s", want, got)
	}
}

func TestInjectRosterFallsBackForMalformedOptionalExtension(t *testing.T) {
	// A legacy extension containing an XML control byte is invalid according
	// to encoding/xml, but Riot's stream parser has historically forwarded it.
	// The proxy must preserve the roster instead of disconnecting chat.
	raw := []byte("<iq><query xmlns='jabber:iq:riotgames:roster'><item jid='friend@test'>\x01</item></query></iq>")
	result, inserted, err := InjectRoster(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !inserted || !bytes.Contains(result, []byte(JID)) || !bytes.Contains(result, []byte("\x01")) {
		t.Fatalf("malformed roster was not preserved and augmented: inserted=%v result=%q", inserted, result)
	}
}

func TestInjectRosterPassesThroughMalformedNonRosterStanza(t *testing.T) {
	raw := []byte("<iq><item>\x01</item></iq>")
	result, inserted, err := InjectRoster(raw)
	if err != nil {
		t.Fatal(err)
	}
	if inserted || string(result) != string(raw) {
		t.Fatalf("non-roster stanza changed: inserted=%v result=%q", inserted, result)
	}
}

func TestChatMessageEscapesText(t *testing.T) {
	result, err := ChatMessage("a < b & c", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(result), "a < b") || !strings.Contains(string(result), "&lt;") {
		t.Fatalf("unsafe message: %s", result)
	}
}
