package chatproxy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/configproxy"
	"github.com/HassanSalah120/RiftOps/internal/model"
)

type EndpointProvider func() (configproxy.Endpoint, bool)

type Proxy struct {
	listener       net.Listener
	certificate    tls.Certificate
	endpoint       EndpointProvider
	policy         PolicyProvider
	maxFrame       int
	commandHandler CommandHandler
	sessionHandler func()
	rosterHandler  func()
	mu             sync.RWMutex
	sessions       map[*Session]struct{}
}

func (p *Proxy) SetCommandHandler(handler CommandHandler) {
	p.mu.Lock()
	p.commandHandler = handler
	for session := range p.sessions {
		session.SetCommandHandler(handler)
	}
	p.mu.Unlock()
}

func (p *Proxy) SetSessionHandler(handler func()) {
	p.mu.Lock()
	p.sessionHandler = handler
	p.mu.Unlock()
}

func (p *Proxy) SetRosterHandler(handler func()) {
	p.mu.Lock()
	p.rosterHandler = handler
	for session := range p.sessions {
		session.SetRosterHandler(handler)
	}
	p.mu.Unlock()
}

func Listen(address string) (net.Listener, error) {
	if address == "" {
		address = "127.0.0.1:0"
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	host, _, _ := net.SplitHostPort(listener.Addr().String())
	if host != "127.0.0.1" && host != "::1" {
		listener.Close()
		return nil, fmt.Errorf("chat proxy must bind to loopback, got %s", host)
	}
	return listener, nil
}

func NewProxy(listener net.Listener, certificate tls.Certificate, endpoint EndpointProvider, policy PolicyProvider) *Proxy {
	return &Proxy{listener: listener, certificate: certificate, endpoint: endpoint,
		policy: policy, maxFrame: 1 << 20, sessions: make(map[*Session]struct{})}
}

func (p *Proxy) Run(ctx context.Context) error {
	go func() { <-ctx.Done(); _ = p.listener.Close() }()
	for {
		connection, err := p.listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go p.serve(ctx, connection)
	}
}

func (p *Proxy) serve(ctx context.Context, raw net.Conn) {
	endpoint, ok := p.endpoint()
	if !ok {
		slog.Warn("rejected chat connection before Riot endpoint was available")
		_ = raw.Close()
		return
	}
	slog.Debug("accepted local Riot chat connection", "upstreamHost", endpoint.Host, "upstreamPort", endpoint.Port)
	incoming := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{p.certificate}, MinVersion: tls.VersionTLS12})
	_ = incoming.SetDeadline(time.Now().Add(20 * time.Second))
	if err := incoming.HandshakeContext(ctx); err != nil {
		slog.Warn("local Riot chat TLS handshake failed", "error", err)
		incoming.Close()
		return
	}
	_ = incoming.SetDeadline(time.Time{})
	dialer := &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
	outgoing, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort(endpoint.Host, fmt.Sprint(endpoint.Port)), &tls.Config{
		ServerName: endpoint.Host, MinVersion: tls.VersionTLS12,
	})
	if err != nil {
		slog.Warn("upstream Riot chat TLS connection failed", "host", endpoint.Host, "port", endpoint.Port, "error", err)
		incoming.Close()
		return
	}
	slog.Debug("Riot chat proxy session established", "upstreamHost", endpoint.Host, "upstreamPort", endpoint.Port)
	session := NewSession(incoming, outgoing, p.policy, p.maxFrame)
	p.mu.RLock()
	handler := p.commandHandler
	rosterHandler := p.rosterHandler
	p.mu.RUnlock()
	session.SetCommandHandler(handler)
	session.SetRosterHandler(rosterHandler)
	p.mu.Lock()
	p.sessions[session] = struct{}{}
	sessionHandler := p.sessionHandler
	p.mu.Unlock()
	if sessionHandler != nil {
		sessionHandler()
	}
	defer func() { p.mu.Lock(); delete(p.sessions, session); p.mu.Unlock() }()
	if err := session.Run(ctx); err != nil {
		slog.Warn("Riot chat proxy session ended", "error", err)
	} else {
		slog.Debug("Riot chat proxy session ended cleanly")
	}
}

func (p *Proxy) SendFakeMessage(ctx context.Context, message string) error {
	p.mu.RLock()
	sessions := make([]*Session, 0, len(p.sessions))
	for session := range p.sessions {
		sessions = append(sessions, session)
	}
	p.mu.RUnlock()
	for _, session := range sessions {
		if err := session.SendFakeMessage(ctx, message); err != nil {
			return err
		}
	}
	return nil
}

func (p *Proxy) UpdateStatus(ctx context.Context, status model.Status) error {
	p.mu.RLock()
	sessions := make([]*Session, 0, len(p.sessions))
	for session := range p.sessions {
		sessions = append(sessions, session)
	}
	p.mu.RUnlock()
	for _, session := range sessions {
		if err := session.UpdateStatus(ctx, status); err != nil {
			return err
		}
	}
	return nil
}
