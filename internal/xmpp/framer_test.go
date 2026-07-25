package xmpp

import (
	"bytes"
	"io"
	"testing"
)

func TestFramerXMPPStream(t *testing.T) {
	input := "<?xml version='1.0'?><stream:stream xmlns:stream='http://etherx.jabber.org/streams'>" +
		"<presence><show>chat</show><games><league_of_legends><st>chat</st></league_of_legends></games></presence>" +
		"<message><body>hello</body></message></stream:stream>"
	wantKinds := []FrameKind{FrameMarkup, FrameStreamOpen, FrameStanza, FrameStanza, FrameStreamClose}
	wantNames := []string{"", "stream:stream", "presence", "message", "stream:stream"}
	f := NewFramer(bytes.NewBufferString(input), 4096)
	for i := range wantKinds {
		frame, err := f.Next()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if frame.Kind != wantKinds[i] || frame.Name != wantNames[i] {
			t.Fatalf("frame %d = (%v, %q), want (%v, %q)", i, frame.Kind, frame.Name, wantKinds[i], wantNames[i])
		}
	}
	if _, err := f.Next(); err != io.EOF {
		t.Fatalf("end error = %v, want EOF", err)
	}
}

func TestFramerEverySplitPoint(t *testing.T) {
	input := []byte("<presence from='a'><show>chat</show><!-- x --><status><![CDATA[ok>]]></status></presence>")
	for split := 0; split <= len(input); split++ {
		r := io.MultiReader(bytes.NewReader(input[:split]), bytes.NewReader(input[split:]))
		frame, err := NewFramer(r, 4096).Next()
		if err != nil {
			t.Fatalf("split %d: %v", split, err)
		}
		if !bytes.Equal(frame.Raw, input) {
			t.Fatalf("split %d changed frame: %q", split, frame.Raw)
		}
	}
}

func TestFramerLimit(t *testing.T) {
	_, err := NewFramer(bytes.NewBufferString("<presence>too large</presence>"), 10).Next()
	if err != ErrFrameTooLarge {
		t.Fatalf("error = %v, want ErrFrameTooLarge", err)
	}
}
