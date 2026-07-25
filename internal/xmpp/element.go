package xmpp

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
)

type Node interface {
	encode(*xml.Encoder) error
}

type Element struct {
	Start    xml.StartElement
	Children []Node
}

type CharData struct{ Data []byte }
type Comment struct{ Data []byte }
type Directive struct{ Data []byte }
type ProcInst struct {
	Target string
	Inst   []byte
}

func ParseElement(raw []byte) (*Element, error) {
	decoder := xml.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	start, ok := token.(xml.StartElement)
	if !ok {
		return nil, fmt.Errorf("expected XML element, got %T", token)
	}
	root, err := decodeElement(decoder, start)
	if err != nil {
		return nil, err
	}
	for {
		token, err = decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if data, ok := token.(xml.CharData); !ok || len(bytes.TrimSpace(data)) != 0 {
			return nil, fmt.Errorf("unexpected XML after root element: %T", token)
		}
	}
	return root, nil
}

func decodeElement(decoder *xml.Decoder, start xml.StartElement) (*Element, error) {
	element := &Element{Start: start.Copy()}
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			child, err := decodeElement(decoder, value)
			if err != nil {
				return nil, err
			}
			element.Children = append(element.Children, child)
		case xml.EndElement:
			return element, nil
		case xml.CharData:
			element.Children = append(element.Children, &CharData{Data: append([]byte(nil), value...)})
		case xml.Comment:
			element.Children = append(element.Children, &Comment{Data: append([]byte(nil), value...)})
		case xml.Directive:
			element.Children = append(element.Children, &Directive{Data: append([]byte(nil), value...)})
		case xml.ProcInst:
			element.Children = append(element.Children, &ProcInst{Target: value.Target, Inst: append([]byte(nil), value.Inst...)})
		}
	}
}

func (e *Element) Encode() ([]byte, error) {
	var out bytes.Buffer
	encoder := xml.NewEncoder(&out)
	if err := e.encode(encoder); err != nil {
		return nil, err
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (e *Element) encode(encoder *xml.Encoder) error {
	if err := encoder.EncodeToken(e.Start); err != nil {
		return err
	}
	for _, child := range e.Children {
		if err := child.encode(encoder); err != nil {
			return err
		}
	}
	return encoder.EncodeToken(e.Start.End())
}

func (n *CharData) encode(e *xml.Encoder) error  { return e.EncodeToken(xml.CharData(n.Data)) }
func (n *Comment) encode(e *xml.Encoder) error   { return e.EncodeToken(xml.Comment(n.Data)) }
func (n *Directive) encode(e *xml.Encoder) error { return e.EncodeToken(xml.Directive(n.Data)) }
func (n *ProcInst) encode(e *xml.Encoder) error {
	return e.EncodeToken(xml.ProcInst{Target: n.Target, Inst: n.Inst})
}

func (e *Element) LocalName() string { return e.Start.Name.Local }

func (e *Element) Attr(local string) (string, bool) {
	for _, attr := range e.Start.Attr {
		if attr.Name.Local == local {
			return attr.Value, true
		}
	}
	return "", false
}

func (e *Element) Child(local string) *Element {
	for _, node := range e.Children {
		if child, ok := node.(*Element); ok && child.LocalName() == local {
			return child
		}
	}
	return nil
}

func (e *Element) RemoveChildren(names ...string) {
	remove := make(map[string]bool, len(names))
	for _, name := range names {
		remove[name] = true
	}
	kept := e.Children[:0]
	for _, node := range e.Children {
		child, ok := node.(*Element)
		if ok && remove[child.LocalName()] {
			continue
		}
		kept = append(kept, node)
	}
	e.Children = kept
}

func (e *Element) Text() string {
	var out bytes.Buffer
	for _, node := range e.Children {
		if data, ok := node.(*CharData); ok {
			out.Write(data.Data)
		}
	}
	return out.String()
}

func (e *Element) SetText(text string) {
	e.Children = []Node{&CharData{Data: []byte(text)}}
}
