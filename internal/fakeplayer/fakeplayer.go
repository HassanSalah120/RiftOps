package fakeplayer

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/xmpp"
)

const (
	UUID            = "41c322a1-b328-495b-a004-5ccd3e45eae8"
	JID             = UUID + "@eu1.pvp.net"
	rosterNamespace = "jabber:iq:riotgames:roster"
	rosterItemXML   = `<item jid='` + JID + `' name='&#9;RiftOps Active!' subscription='both' puuid='` + UUID + `'>` +
		`<group priority='9999'>RiftOps</group><state>online</state><id name='&#9;RiftOps Active!' tagline='...'/>` +
		`<lol name='&#9;RiftOps Active!'/><platforms><riot name='&#9;RiftOps Active' tagline='...'/></platforms></item>`
)

type Command string

const (
	CommandOnline  Command = "online"
	CommandOffline Command = "offline"
	CommandMobile  Command = "mobile"
	CommandEnable  Command = "enable"
	CommandDisable Command = "disable"
	CommandStatus  Command = "status"
	CommandHelp    Command = "help"
)

func ParseCommand(raw []byte) (Command, bool, error) {
	root, err := xmpp.ParseElement(raw)
	if err != nil {
		return "", false, err
	}
	if root.LocalName() != "message" {
		return "", false, nil
	}
	to, ok := root.Attr("to")
	if !ok || (to != JID && !strings.HasPrefix(to, JID+"/")) {
		return "", false, nil
	}
	body := root.Child("body")
	if body == nil {
		return "", true, nil
	}
	text := strings.ToLower(strings.TrimSpace(body.Text()))
	for _, command := range []Command{CommandOffline, CommandMobile, CommandOnline, CommandEnable, CommandDisable, CommandStatus, CommandHelp} {
		if text == string(command) {
			return command, true, nil
		}
	}
	return "", true, nil
}

// InjectRoster inserts the RiftOps control contact without re-encoding Riot's
// roster. Riot includes extension XML whose byte-level shape is significant to
// some client versions; parsing and serializing the whole stanza can make the
// friend list reject an otherwise valid roster.
func InjectRoster(raw []byte) ([]byte, bool, error) {
	if bytes.Contains(raw, []byte(JID)) {
		return raw, false, nil
	}

	decoder := xml.NewDecoder(bytes.NewReader(raw))
	depth := 0
	rosterDepth := -1
	rootIsIQ := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// Riot occasionally adds extension payloads that are accepted by its
			// XML stream parser but rejected by encoding/xml (for example, a
			// control character in a legacy extension). A malformed optional
			// extension must never tear down the whole chat connection: fall back
			// to a byte-preserving insertion at the roster query opening tag.
			if modified, inserted := injectRosterAfterOpeningTag(raw); inserted {
				return modified, true, nil
			}
			return raw, false, nil
		}
		switch value := token.(type) {
		case xml.StartElement:
			depth++
			if depth == 1 {
				rootIsIQ = value.Name.Local == "iq"
				if !rootIsIQ {
					return raw, false, nil
				}
			}
			if rosterDepth < 0 && value.Name.Local == "query" && value.Name.Space == rosterNamespace {
				rosterDepth = depth
			}
		case xml.EndElement:
			if rosterDepth == depth && value.Name.Local == "query" && value.Name.Space == rosterNamespace {
				endOffset := int(decoder.InputOffset())
				closingOffset := bytes.LastIndex(raw[:endOffset], []byte("</"))
				if closingOffset < 0 {
					return nil, false, errors.New("roster query closing tag was not found")
				}
				result := make([]byte, 0, len(raw)+len(rosterItemXML))
				result = append(result, raw[:closingOffset]...)
				result = append(result, rosterItemXML...)
				result = append(result, raw[closingOffset:]...)
				return result, true, nil
			}
			depth--
		}
	}
	if modified, inserted := injectRosterAfterOpeningTag(raw); inserted {
		return modified, true, nil
	}
	return raw, false, nil
}

// injectRosterAfterOpeningTag is deliberately conservative. It only looks at
// an IQ stanza's opening query tag and inserts the control item immediately
// after it, preserving every byte Riot sent (including unknown extensions).
// This mirrors the tolerant behavior of the original Deceive proxy while the
// structured path above handles well-formed stanzas safely.
func injectRosterAfterOpeningTag(raw []byte) ([]byte, bool) {
	if !bytes.Contains(raw, []byte("<iq")) {
		return raw, false
	}
	for offset := 0; offset < len(raw); {
		relative := bytes.IndexByte(raw[offset:], '<')
		if relative < 0 {
			return raw, false
		}
		start := offset + relative
		end := bytes.IndexByte(raw[start:], '>')
		if end < 0 {
			return raw, false
		}
		end += start
		tag := raw[start : end+1]
		name := rosterTagName(tag)
		if name == "query" && bytes.Contains(tag, []byte(rosterNamespace)) && !bytes.HasSuffix(bytes.TrimSpace(tag[:len(tag)-1]), []byte("/")) {
			modified := make([]byte, 0, len(raw)+len(rosterItemXML))
			modified = append(modified, raw[:end+1]...)
			modified = append(modified, rosterItemXML...)
			modified = append(modified, raw[end+1:]...)
			return modified, true
		}
		offset = end + 1
	}
	return raw, false
}

func rosterTagName(tag []byte) string {
	text := strings.TrimSpace(string(tag))
	text = strings.TrimPrefix(text, "<")
	text = strings.TrimSpace(strings.TrimSuffix(text, ">"))
	text = strings.TrimPrefix(text, "/")
	if index := strings.IndexAny(text, " \t\r\n/"); index >= 0 {
		text = text[:index]
	}
	if index := strings.LastIndexByte(text, ':'); index >= 0 {
		text = text[index+1:]
	}
	return text
}

func ChatMessage(message string, now time.Time) ([]byte, error) {
	stamp := now.UTC().Add(time.Second).Format("2006-01-02 15:04:05.000")
	buf := new(bytes.Buffer)
	buf.WriteString("<message from='")
	buf.WriteString(JID)
	buf.WriteString("/RC-RiftOps' stamp='")
	buf.WriteString(stamp)
	buf.WriteString("' id='fake-")
	buf.WriteString(stamp)
	buf.WriteString("' type='chat'><body>")
	// XML-escape the message body
	for _, r := range message {
		switch r {
		case '&':
			buf.WriteString("&amp;")
		case '<':
			buf.WriteString("&lt;")
		case '>':
			buf.WriteString("&gt;")
		case '\'':
			buf.WriteString("&apos;")
		case '"':
			buf.WriteString("&quot;")
		default:
			buf.WriteRune(r)
		}
	}
	buf.WriteString("</body></message>")
	return buf.Bytes(), nil
}

// valorantPresenceData holds the structured JSON embedded inside <valorant><p>.
type valorantPresenceData struct {
	IsValid       bool               `json:"isValid"`
	IsIdle        bool               `json:"isIdle"`
	QueueID       string             `json:"queueId"`
	PartyPresence partyPresenceData  `json:"partyPresenceData"`
	PlayerPres    playerPresenceData `json:"playerPresenceData"`
}

type partyPresenceData struct {
	PartyID            string `json:"partyId"`
	IsPartyOwner       bool   `json:"isPartyOwner"`
	PartyState         string `json:"partyState"`
	PartyAccessibility string `json:"partyAccessibility"`
	PartyClientVersion string `json:"partyClientVersion"`
	PartySize          int    `json:"partySize"`
	MaxPartySize       int    `json:"maxPartySize"`
	CustomGameName     string `json:"customGameName"`
}

type playerPresenceData struct {
	AccountLevel    int `json:"accountLevel"`
	CompetitiveTier int `json:"competitiveTier"`
}

// Presence builds a RiftOps presence stanza using proper XML construction.
func Presence(valorantVersion string, now time.Time) ([]byte, error) {
	if valorantVersion == "" {
		valorantVersion = "unknown"
	}
	valorantJSON, err := json.Marshal(valorantPresenceData{
		IsValid: true, IsIdle: false, QueueID: "competitive",
		PartyPresence: partyPresenceData{
			PartyID:            "00000000-0000-0000-0000-000000000000",
			IsPartyOwner:       true,
			PartyState:         "DEFAULT",
			PartyAccessibility: "CLOSED",
			PartyClientVersion: valorantVersion,
			PartySize:          1, MaxPartySize: 5,
			CustomGameName: "RiftOps Active!",
		},
		PlayerPres: playerPresenceData{AccountLevel: 999, CompetitiveTier: 0},
	})
	if err != nil {
		return nil, err
	}
	timestamp := now.UnixMilli()

	// Build the full presence tree using xmpp.Element
	presence := &xmpp.Element{
		Start: xmlStart("presence",
			xmlAttr("from", JID+"/RC-RiftOps"),
			xmlAttr("id", fmt.Sprintf("b-%d", timestamp)),
		),
	}

	games := &xmpp.Element{Start: xmlStart("games")}
	ts := fmt.Sprintf("%d", timestamp)

	games.Children = append(games.Children,
		gameEl("keystone",
			textEl("st", "chat"), textEl("s.t", ts), textEl("s.p", "keystone"), emptyEl("pty"),
		),
		gameEl("league_of_legends",
			textEl("st", "chat"), textEl("s.t", ts), textEl("s.p", "league_of_legends"),
			textEl("s.c", "live"), textEl("p", `{"pty":true}`),
		),
		gameEl("valorant",
			textEl("st", "chat"), textEl("s.t", ts), textEl("s.p", "valorant"), textEl("s.r", "PC"),
			textEl("p", base64.StdEncoding.EncodeToString(valorantJSON)), emptyEl("pty"),
		),
		gameEl("bacon",
			textEl("st", "chat"), textEl("s.t", ts), textEl("s.l", "bacon_availability_online"), textEl("s.p", "bacon"),
		),
	)

	presence.Children = append(presence.Children,
		games,
		textEl("show", "chat"),
		textEl("platform", "riot"),
		&xmpp.Element{Start: xmlStart("status")},
	)

	return presence.Encode()
}

// --- xml element helpers ---

type elAttr struct{ name, value string }

func xmlAttr(name, value string) elAttr {
	return elAttr{name: name, value: value}
}

func xmlStart(name string, attrs ...elAttr) xml.StartElement {
	start := xml.StartElement{Name: xml.Name{Local: name}}
	for _, a := range attrs {
		start.Attr = append(start.Attr, xml.Attr{Name: xml.Name{Local: a.name}, Value: a.value})
	}
	return start
}

func textEl(name, text string) *xmpp.Element {
	return &xmpp.Element{
		Start:    xmlStart(name),
		Children: []xmpp.Node{&xmpp.CharData{Data: []byte(text)}},
	}
}

func emptyEl(name string) *xmpp.Element {
	return &xmpp.Element{Start: xmlStart(name)}
}

func gameEl(name string, children ...*xmpp.Element) *xmpp.Element {
	el := &xmpp.Element{Start: xmlStart(name)}
	for _, c := range children {
		el.Children = append(el.Children, c)
	}
	return el
}
