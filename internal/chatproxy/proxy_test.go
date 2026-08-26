package chatproxy

import (
	"context"
	"crypto/tls"
	"net"
	"testing"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/configproxy"
	"github.com/HassanSalah120/RiftOps/internal/presence"
)

func TestProxyReportsLocalTLSHandshakeFailure(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	proxy := NewProxy(nil, tls.Certificate{}, func() (configproxy.Endpoint, bool) {
		return configproxy.Endpoint{Host: "chat.riot.test", Port: 5223}, true
	}, func() presence.Options { return presence.Options{} })

	done := make(chan struct{})
	go func() {
		proxy.serve(context.Background(), server)
		close(done)
	}()
	tlsClient := tls.Client(client, &tls.Config{InsecureSkipVerify: true}) // test-only client for a deliberately invalid server
	_ = tlsClient.SetDeadline(time.Now().Add(time.Second))
	if err := tlsClient.Handshake(); err == nil {
		t.Fatal("handshake unexpectedly succeeded")
	}

	select {
	case <-proxy.TLSFailures():
	case <-time.After(time.Second):
		t.Fatal("TLS failure was not reported")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("proxy connection did not stop")
	}
}
