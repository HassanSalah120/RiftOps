package chatproxy

import (
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/presence"
)

func TestSessionTransformsPresenceAndPreservesOtherFrames(t *testing.T) {
	clientApp, clientProxy := net.Pipe()
	serverProxy, serverApp := net.Pipe()
	session := NewSession(clientProxy, serverProxy, func() presence.Options {
		return presence.Options{Status: model.StatusOffline, ConnectToMUC: true}
	}, 4096)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = session.Run(ctx) }()

	input := "<presence><show>chat</show><games><league_of_legends><st>chat</st></league_of_legends></games></presence><message><body>hi</body></message>"
	go func() { _, _ = io.WriteString(clientApp, input) }()
	_ = serverApp.SetReadDeadline(time.Now().Add(time.Second))
	buffer := make([]byte, 4096)
	n, err := serverApp.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	output := string(buffer[:n])
	if !strings.Contains(output, "<show>offline</show>") {
		t.Fatalf("presence was not transformed: %s", output)
	}
	if !bytes.Contains(buffer[:n], []byte("<message><body>hi</body></message>")) {
		// It is valid for the second frame to arrive as a subsequent write.
		n2, err := serverApp.Read(buffer[n:])
		if err != nil {
			t.Fatal(err)
		}
		output += string(buffer[n : n+n2])
		if !strings.Contains(output, "<message><body>hi</body></message>") {
			t.Fatalf("message was changed or lost: %s", output)
		}
	}
}

func TestSessionSignalsRosterReadyAfterInjectingControlContact(t *testing.T) {
	clientApp, clientProxy := net.Pipe()
	serverProxy, serverApp := net.Pipe()
	session := NewSession(clientProxy, serverProxy, func() presence.Options {
		return presence.Options{Status: model.StatusOffline}
	}, 4096)
	ready := make(chan struct{}, 1)
	session.SetRosterHandler(func() {
		ready <- struct{}{}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer clientApp.Close()
	defer serverApp.Close()
	go func() { _ = session.Run(ctx) }()
	// Drain both the rewritten roster and the synthetic RiftOps presence so
	// the net.Pipe writer can finish before the callback is dispatched.
	go func() { _, _ = io.Copy(io.Discard, clientApp) }()

	roster := "<iq><query xmlns='jabber:iq:riotgames:roster'><item jid='someone@test'/></query></iq>"
	go func() { _, _ = io.WriteString(serverApp, roster) }()

	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("roster-ready callback was not invoked")
	}
}
