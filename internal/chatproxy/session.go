package chatproxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/fakeplayer"
	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/presence"
	"github.com/HassanSalah120/RiftOps/internal/xmpp"
)

type PolicyProvider func() presence.Options
type CommandHandler func(fakeplayer.Command)

type Session struct {
	client             io.ReadWriteCloser
	server             io.ReadWriteCloser
	policy             PolicyProvider
	maxFrame           int
	toClient           *writePump
	toServer           *writePump
	lastMu             sync.RWMutex
	lastPresence       []byte
	stateMu            sync.Mutex
	insertedFakePlayer bool
	sentFakePresence   bool
	valorantVersion    string
	handlerMu          sync.RWMutex
	commandHandler     CommandHandler
	rosterHandler      func()
}

func (s *Session) SetCommandHandler(handler CommandHandler) {
	s.handlerMu.Lock()
	s.commandHandler = handler
	s.handlerMu.Unlock()
}

func (s *Session) SetRosterHandler(handler func()) {
	s.handlerMu.Lock()
	s.rosterHandler = handler
	s.handlerMu.Unlock()
}

func NewSession(client, server io.ReadWriteCloser, policy PolicyProvider, maxFrame int) *Session {
	if maxFrame <= 0 {
		maxFrame = 1 << 20
	}
	return &Session{client: client, server: server, policy: policy, maxFrame: maxFrame,
		toClient: newWritePump(64), toServer: newWritePump(64)}
}

func (s *Session) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer s.client.Close()
	defer s.server.Close()
	errorsCh := make(chan error, 4)
	go func() { errorsCh <- fmt.Errorf("client writer: %w", s.toClient.run(ctx, s.client)) }()
	go func() { errorsCh <- fmt.Errorf("server writer: %w", s.toServer.run(ctx, s.server)) }()
	go func() { errorsCh <- fmt.Errorf("client reader: %w", s.readClient(ctx)) }()
	go func() { errorsCh <- fmt.Errorf("server reader: %w", s.readServer(ctx)) }()
	err := <-errorsCh
	cancel()
	if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (s *Session) readClient(ctx context.Context) error {
	framer := xmpp.NewFramer(s.client, s.maxFrame)
	for {
		frame, err := framer.Next()
		if err != nil {
			return err
		}
		data := frame.Raw
		if frame.Kind == xmpp.FrameStanza && localName(frame.Name) == "message" {
			command, handled, commandErr := fakeplayer.ParseCommand(frame.Raw)
			if commandErr != nil {
				return commandErr
			}
			if handled {
				s.handlerMu.RLock()
				handler := s.commandHandler
				s.handlerMu.RUnlock()
				if command != "" && handler != nil {
					handler(command)
				}
				continue
			}
		}
		if frame.Kind == xmpp.FrameStanza && localName(frame.Name) == "presence" {
			s.lastMu.Lock()
			s.lastPresence = append([]byte(nil), frame.Raw...)
			s.lastMu.Unlock()
			result, transformErr := presence.Transform(frame.Raw, s.policy())
			if transformErr != nil {
				return transformErr
			}
			if result.Drop {
				continue
			}
			resendFakePresence := false
			if result.ValorantVersion != "" {
				s.stateMu.Lock()
				if s.valorantVersion != result.ValorantVersion {
					s.valorantVersion = result.ValorantVersion
					resendFakePresence = s.insertedFakePlayer
				}
				s.stateMu.Unlock()
			}
			data = result.Raw
			if resendFakePresence {
				if err := s.sendFakePresence(ctx); err != nil {
					return err
				}
			}
		}
		if err := s.toServer.write(ctx, data); err != nil {
			return err
		}
	}
}

func (s *Session) readServer(ctx context.Context) error {
	framer := xmpp.NewFramer(s.server, s.maxFrame)
	for {
		frame, err := framer.Next()
		if err != nil {
			return err
		}
		data := frame.Raw
		inserted := false
		s.stateMu.Lock()
		alreadyInserted := s.insertedFakePlayer
		s.stateMu.Unlock()
		if frame.Kind == xmpp.FrameStanza && !alreadyInserted {
			modified, didInsert, injectErr := fakeplayer.InjectRoster(frame.Raw)
			if injectErr != nil {
				return injectErr
			}
			if didInsert {
				data = modified
				inserted = true
				slog.Debug("inserted RiftOps control contact into Riot roster")
				s.stateMu.Lock()
				s.insertedFakePlayer = true
				s.stateMu.Unlock()
			}
		}
		if err := s.toClient.write(ctx, data); err != nil {
			return err
		}
		if inserted {
			if err := s.sendFakePresence(ctx); err != nil {
				return err
			}
			s.handlerMu.RLock()
			handler := s.rosterHandler
			s.handlerMu.RUnlock()
			if handler != nil {
				handler()
			}
		}
	}
}

func (s *Session) sendFakePresence(ctx context.Context) error {
	s.stateMu.Lock()
	version := s.valorantVersion
	s.sentFakePresence = true
	s.stateMu.Unlock()
	data, err := fakeplayer.Presence(version, time.Now())
	if err != nil {
		return err
	}
	return s.toClient.write(ctx, data)
}

func (s *Session) SendFakeMessage(ctx context.Context, message string) error {
	data, err := fakeplayer.ChatMessage(message, time.Now())
	if err != nil {
		return err
	}
	return s.toClient.write(ctx, data)
}

func (s *Session) UpdateStatus(ctx context.Context, status model.Status) error {
	s.lastMu.RLock()
	raw := append([]byte(nil), s.lastPresence...)
	s.lastMu.RUnlock()
	if len(raw) == 0 {
		return nil
	}
	options := s.policy()
	options.Status = status
	result, err := presence.Transform(raw, options)
	if err != nil || result.Drop {
		return err
	}
	return s.toServer.write(ctx, result.Raw)
}

func localName(name string) string {
	for i := len(name) - 1; i >= 0; i-- {
		if name[i] == ':' {
			return name[i+1:]
		}
	}
	return name
}
