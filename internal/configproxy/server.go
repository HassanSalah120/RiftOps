package configproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultUpstream = "https://clientconfig.rpg.riotgames.com"
	DefaultGeoPAS   = "https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat"
	MaxConfigBytes  = 8 << 20
)

type Server struct {
	listener        net.Listener
	http            *http.Server
	client          *http.Client
	upstream        *url.URL
	geoPAS          string
	localHost       string
	chatPort        int
	passThroughChat bool
	endpoints       chan Endpoint
	onEndpoint      func(Endpoint)
	logger          *slog.Logger
}

type ServerOptions struct {
	ListenAddress string
	LocalChatHost string
	LocalChatPort int
	Upstream      string
	GeoPAS        string
	HTTPClient    *http.Client
	Logger        *slog.Logger
	OnEndpoint    func(Endpoint)
	// PassThroughChat forwards Riot's client configuration byte-for-byte. It is
	// used as the reliable fallback when Riot rejects the local TLS certificate.
	PassThroughChat bool
}

func NewServer(options ServerOptions) (*Server, error) {
	if options.ListenAddress == "" {
		options.ListenAddress = "127.0.0.1:0"
	}
	if options.LocalChatHost == "" && !options.PassThroughChat {
		return nil, errors.New("local chat hostname is required")
	}
	if options.Upstream == "" {
		options.Upstream = DefaultUpstream
	}
	if options.GeoPAS == "" {
		options.GeoPAS = DefaultGeoPAS
	}
	upstream, err := url.Parse(options.Upstream)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return nil, fmt.Errorf("invalid config upstream %q", options.Upstream)
	}
	listener, err := net.Listen("tcp", options.ListenAddress)
	if err != nil {
		return nil, fmt.Errorf("listen for config requests: %w", err)
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{
		listener: listener, client: client, upstream: upstream,
		geoPAS: options.GeoPAS, localHost: options.LocalChatHost,
		chatPort: options.LocalChatPort, passThroughChat: options.PassThroughChat,
		endpoints:  make(chan Endpoint, 8),
		onEndpoint: options.OnEndpoint, logger: logger,
	}
	s.http = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return s, nil
}

func (s *Server) URL() string                { return "http://" + s.listener.Addr().String() }
func (s *Server) Endpoints() <-chan Endpoint { return s.endpoints }

func (s *Server) Run() error {
	err := s.http.Serve(s.listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Close(ctx context.Context) error { return s.http.Shutdown(ctx) }

func (s *Server) ServeHTTP(w http.ResponseWriter, incoming *http.Request) {
	target := *s.upstream
	target.Path = strings.TrimRight(s.upstream.Path, "/") + incoming.URL.Path
	target.RawQuery = incoming.URL.RawQuery
	request, err := http.NewRequestWithContext(incoming.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, "invalid upstream request", http.StatusBadGateway)
		return
	}
	copyAllowedHeaders(request.Header, incoming.Header)
	response, err := s.client.Do(request)
	if err != nil {
		s.logger.Warn("client config upstream failed", "error", err)
		http.Error(w, "client config upstream unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxConfigBytes+1))
	if err != nil || len(body) > MaxConfigBytes {
		http.Error(w, "client config response was invalid", http.StatusBadGateway)
		return
	}

	result := body
	if response.StatusCode >= 200 && response.StatusCode < 300 && !s.passThroughChat {
		affinity := ""
		if configUsesAffinity(body) {
			affinity = s.fetchAffinity(incoming.Context(), incoming.Header.Get("Authorization"))
		}
		modified, endpoint, rewriteErr := Rewrite(body, RewriteOptions{
			LocalHost: s.localHost, LocalPort: s.chatPort, Affinity: affinity,
		})
		if rewriteErr != nil {
			s.logger.Error("client config rewrite failed", "error", rewriteErr)
			http.Error(w, "client config format is unsupported", http.StatusBadGateway)
			return
		}
		result = modified
		if endpoint.Valid() {
			s.logger.Debug("rewrote Riot chat configuration", "path", incoming.URL.Path, "localHost", s.localHost, "localPort", s.chatPort, "upstreamHost", endpoint.Host, "upstreamPort", endpoint.Port)
			if s.onEndpoint != nil {
				s.onEndpoint(endpoint)
			}
			select {
			case s.endpoints <- endpoint:
			default:
				s.logger.Debug("dropping duplicate chat endpoint", "host", endpoint.Host, "port", endpoint.Port)
			}
		} else {
			s.logger.Warn("client config did not contain a complete chat endpoint", "path", incoming.URL.Path)
		}
	} else if response.StatusCode >= 200 && response.StatusCode < 300 {
		s.logger.Debug("forwarded Riot client configuration without chat interception", "path", incoming.URL.Path)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(result)
}

func (s *Server) fetchAffinity(ctx context.Context, authorization string) string {
	if authorization == "" {
		return ""
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.geoPAS, nil)
	if err != nil {
		return ""
	}
	request.Header.Set("Authorization", authorization)
	response, err := s.client.Do(request)
	if err != nil {
		s.logger.Debug("affinity lookup failed", "error", err)
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ""
	}
	token, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return ""
	}
	affinity, err := AffinityFromJWT(strings.TrimSpace(string(token)))
	if err != nil {
		return ""
	}
	return affinity
}

func copyAllowedHeaders(destination, source http.Header) {
	for _, name := range []string{"User-Agent", "Authorization", "X-Riot-Entitlements-JWT"} {
		if value := source.Get(name); value != "" {
			destination.Set(name, value)
		}
	}
}

func configUsesAffinity(body []byte) bool {
	var config map[string]any
	if json.Unmarshal(body, &config) != nil {
		return false
	}
	enabled, _ := config["chat.affinity.enabled"].(bool)
	_, hasAffinities := config["chat.affinities"].(map[string]any)
	return enabled && hasAffinities
}
