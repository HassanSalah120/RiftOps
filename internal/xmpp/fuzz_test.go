package xmpp

import (
	"bytes"
	"testing"
)

func FuzzFramer(f *testing.F) {
	for _, seed := range [][]byte{
		[]byte("<presence/>"),
		[]byte("<message><body>hello</body></message>"),
		[]byte("<iq><query><!--comment--><![CDATA[data>]]></query></iq>"),
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		framer := NewFramer(bytes.NewReader(data), 64<<10)
		for i := 0; i < 100; i++ {
			if _, err := framer.Next(); err != nil {
				return
			}
		}
	})
}
