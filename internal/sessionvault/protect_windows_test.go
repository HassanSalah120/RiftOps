//go:build windows

package sessionvault

import (
	"bytes"
	"testing"
)

func TestWindowsDPAPIRoundTrip(t *testing.T) {
	plaintext := []byte("sensitive-session-state")
	context := []byte("profile-test")
	sealed, err := (platformProtector{}).seal(plaintext, context)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, plaintext) {
		t.Fatal("DPAPI output contained plaintext")
	}
	opened, err := (platformProtector{}).open(sealed, context)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, plaintext) {
		t.Fatalf("opened = %q", opened)
	}
}
