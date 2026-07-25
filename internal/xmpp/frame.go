package xmpp

type FrameKind uint8

const (
	FrameWhitespace FrameKind = iota
	FrameStreamOpen
	FrameStreamClose
	FrameStanza
	FrameMarkup
)

type Frame struct {
	Kind FrameKind
	Name string
	Raw  []byte
}
