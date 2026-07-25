package xmpp

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
)

var ErrFrameTooLarge = errors.New("xmpp frame exceeds configured limit")

type Framer struct {
	r        *bufio.Reader
	maxBytes int
}

func NewFramer(r io.Reader, maxBytes int) *Framer {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	return &Framer{r: bufio.NewReader(r), maxBytes: maxBytes}
}

func (f *Framer) Next() (Frame, error) {
	first, err := f.r.ReadByte()
	if err != nil {
		return Frame{}, err
	}
	if isSpace(first) {
		var out bytes.Buffer
		out.WriteByte(first)
		for out.Len() < f.maxBytes {
			b, err := f.r.ReadByte()
			if err != nil {
				if errors.Is(err, io.EOF) {
					return Frame{Kind: FrameWhitespace, Raw: out.Bytes()}, nil
				}
				return Frame{}, err
			}
			if !isSpace(b) {
				_ = f.r.UnreadByte()
				break
			}
			out.WriteByte(b)
		}
		return Frame{Kind: FrameWhitespace, Raw: out.Bytes()}, nil
	}
	if first != '<' {
		return Frame{}, fmt.Errorf("unexpected XMPP stream byte %q outside stanza", first)
	}

	markup, kind, name, selfClosing, err := f.readMarkup([]byte{'<'})
	if err != nil {
		return Frame{}, err
	}
	if kind != markupElementOpen {
		frameKind := FrameMarkup
		if kind == markupElementClose && localName(name) == "stream" {
			frameKind = FrameStreamClose
		}
		return Frame{Kind: frameKind, Name: name, Raw: markup}, nil
	}
	if localName(name) == "stream" && !selfClosing {
		return Frame{Kind: FrameStreamOpen, Name: name, Raw: markup}, nil
	}
	if selfClosing {
		return Frame{Kind: FrameStanza, Name: name, Raw: markup}, nil
	}

	out := bytes.NewBuffer(make([]byte, 0, min(f.maxBytes, 4096)))
	out.Write(markup)
	depth := 1
	for depth > 0 {
		if out.Len() >= f.maxBytes {
			return Frame{}, ErrFrameTooLarge
		}
		b, err := f.r.ReadByte()
		if err != nil {
			return Frame{}, fmt.Errorf("incomplete XMPP stanza %q: %w", name, err)
		}
		out.WriteByte(b)
		if b != '<' {
			continue
		}
		part, partKind, _, partSelfClosing, err := f.readMarkup([]byte{'<'})
		if err != nil {
			return Frame{}, err
		}
		out.Write(part[1:])
		if out.Len() > f.maxBytes {
			return Frame{}, ErrFrameTooLarge
		}
		switch partKind {
		case markupElementOpen:
			if !partSelfClosing {
				depth++
			}
		case markupElementClose:
			depth--
		}
	}
	return Frame{Kind: FrameStanza, Name: name, Raw: out.Bytes()}, nil
}

type markupKind uint8

const (
	markupOther markupKind = iota
	markupElementOpen
	markupElementClose
)

func (f *Framer) readMarkup(prefix []byte) ([]byte, markupKind, string, bool, error) {
	out := bytes.NewBuffer(make([]byte, 0, 128))
	out.Write(prefix)
	peek, err := f.r.Peek(1)
	if err != nil {
		return nil, markupOther, "", false, err
	}

	if peek[0] == '!' {
		return f.readSpecialMarkup(out)
	}

	quote := byte(0)
	for out.Len() < f.maxBytes {
		b, err := f.r.ReadByte()
		if err != nil {
			return nil, markupOther, "", false, err
		}
		out.WriteByte(b)
		if quote != 0 {
			if b == quote {
				quote = 0
			}
			continue
		}
		if b == '\'' || b == '"' {
			quote = b
			continue
		}
		if b == '>' {
			raw := out.Bytes()
			text := strings.TrimSpace(string(raw[1 : len(raw)-1]))
			if strings.HasPrefix(text, "?") {
				return raw, markupOther, "", false, nil
			}
			closing := strings.HasPrefix(text, "/")
			selfClosing := strings.HasSuffix(text, "/")
			text = strings.TrimSpace(strings.TrimPrefix(text, "/"))
			text = strings.TrimSpace(strings.TrimSuffix(text, "/"))
			name := text
			if idx := strings.IndexAny(name, " \t\r\n"); idx >= 0 {
				name = name[:idx]
			}
			if name == "" {
				return nil, markupOther, "", false, errors.New("empty XML element name")
			}
			kind := markupElementOpen
			if closing {
				kind = markupElementClose
			}
			return raw, kind, name, selfClosing, nil
		}
	}
	return nil, markupOther, "", false, ErrFrameTooLarge
}

func (f *Framer) readSpecialMarkup(out *bytes.Buffer) ([]byte, markupKind, string, bool, error) {
	for out.Len() < 10 {
		b, err := f.r.ReadByte()
		if err != nil {
			return nil, markupOther, "", false, err
		}
		out.WriteByte(b)
		text := out.String()
		switch {
		case strings.HasPrefix(text, "<!--"):
			return f.readUntil(out, []byte("-->"))
		case strings.HasPrefix(text, "<![CDATA["):
			return f.readUntil(out, []byte("]]>"))
		case len(text) >= 3 && !strings.HasPrefix("<!--", text) && !strings.HasPrefix("<![CDATA[", text):
			return f.readDeclaration(out)
		}
	}
	return f.readDeclaration(out)
}

func (f *Framer) readUntil(out *bytes.Buffer, suffix []byte) ([]byte, markupKind, string, bool, error) {
	for out.Len() < f.maxBytes {
		b, err := f.r.ReadByte()
		if err != nil {
			return nil, markupOther, "", false, err
		}
		out.WriteByte(b)
		if bytes.HasSuffix(out.Bytes(), suffix) {
			return out.Bytes(), markupOther, "", false, nil
		}
	}
	return nil, markupOther, "", false, ErrFrameTooLarge
}

func (f *Framer) readDeclaration(out *bytes.Buffer) ([]byte, markupKind, string, bool, error) {
	quote := byte(0)
	brackets := 0
	for out.Len() < f.maxBytes {
		b, err := f.r.ReadByte()
		if err != nil {
			return nil, markupOther, "", false, err
		}
		out.WriteByte(b)
		if quote != 0 {
			if b == quote {
				quote = 0
			}
			continue
		}
		switch b {
		case '\'', '"':
			quote = b
		case '[':
			brackets++
		case ']':
			if brackets > 0 {
				brackets--
			}
		case '>':
			if brackets == 0 {
				return out.Bytes(), markupOther, "", false, nil
			}
		}
	}
	return nil, markupOther, "", false, ErrFrameTooLarge
}

func isSpace(b byte) bool { return b == ' ' || b == '\t' || b == '\r' || b == '\n' }

func localName(name string) string {
	if idx := strings.LastIndexByte(name, ':'); idx >= 0 {
		return name[idx+1:]
	}
	return name
}
