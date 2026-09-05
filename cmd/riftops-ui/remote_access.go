package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

const (
	remotePortStart  = 24081
	remotePortEnd    = 24090
	remotePairTTL    = 5 * time.Minute
	remoteSessionTTL = 8 * time.Hour
	remoteCookie     = "riftops_remote_session"
)

type remoteRequestKey struct{}

type remoteSession struct {
	ID        string    `json:"id"`
	Device    string    `json:"device"`
	CreatedAt time.Time `json:"createdAt"`
	LastSeen  time.Time `json:"lastSeen"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type remoteAccessManager struct {
	mu            sync.Mutex
	pairToken     string
	pairExpiresAt time.Time
	pairURL       string
	displayURL    string
	port          int
	server        *http.Server
	sessions      map[[32]byte]*remoteSession
}

var remoteAccess = &remoteAccessManager{}

type remoteAccessStatus struct {
	Enabled          bool            `json:"enabled"`
	Remote           bool            `json:"remote,omitempty"`
	Client           string          `json:"client"`
	Capabilities     []string        `json:"capabilities"`
	PairingAvailable bool            `json:"pairingAvailable"`
	URL              string          `json:"url,omitempty"`
	DisplayURL       string          `json:"displayUrl,omitempty"`
	Port             int             `json:"port,omitempty"`
	ExpiresAt        string          `json:"expiresAt,omitempty"`
	SessionExpiresIn int             `json:"sessionExpiresInSeconds"`
	Sessions         []remoteSession `json:"sessions,omitempty"`
}

func randomToken(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func newRemotePairToken() (string, error) { return randomToken(32) }

func startRemoteAccess(handler http.Handler) {
	if err := remoteAccess.start(handler); err != nil {
		slog.Warn("Phone control is unavailable", "error", err)
		return
	}
	status := remoteAccess.status(false)
	slog.Info("Phone control ready", "url", status.DisplayURL, "pairExpires", status.ExpiresAt)
}

func stopRemoteAccess() { remoteAccess.shutdown() }

// start creates a separate, private-LAN listener. Authentication is followed
// by an explicit route scope so a paired phone never inherits the desktop's
// filesystem, update, quit, credential-session, or diagnostics capabilities.
func (m *remoteAccessManager) start(handler http.Handler) error {
	m.mu.Lock()
	if m.server != nil {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	host := localLANAddress()
	if host == "" {
		return errors.New("no active private IPv4 network address was found")
	}
	listener, port, err := listenRemotePort(host)
	if err != nil {
		return err
	}
	displayURL := "http://" + net.JoinHostPort(host, strconv.Itoa(port))
	server := &http.Server{
		Handler:           remoteSecurityHeaders(m.guard(remoteRouteScope(recoveryMiddleware(handler)))),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       20 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	m.mu.Lock()
	if m.server != nil {
		m.mu.Unlock()
		_ = listener.Close()
		return nil
	}
	m.displayURL = displayURL
	m.port = port
	m.server = server
	m.sessions = make(map[[32]byte]*remoteSession)
	if err := m.issuePairLocked(); err != nil {
		m.server = nil
		m.mu.Unlock()
		_ = listener.Close()
		return fmt.Errorf("generate mobile pairing token: %w", err)
	}
	m.mu.Unlock()

	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			slog.Warn("RiftOps mobile listener stopped", "error", serveErr)
		}
		m.mu.Lock()
		if m.server == server {
			m.server = nil
			m.sessions = nil
		}
		m.mu.Unlock()
	}()
	return nil
}

func (m *remoteAccessManager) issuePairLocked() error {
	token, err := newRemotePairToken()
	if err != nil {
		return err
	}
	m.pairToken = token
	m.pairExpiresAt = time.Now().Add(remotePairTTL)
	m.pairURL = m.displayURL + "/?pair=" + url.QueryEscape(token)
	return nil
}

func (m *remoteAccessManager) newPair(revokeSessions bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.server == nil {
		return errors.New("mobile access is not running")
	}
	if revokeSessions {
		m.sessions = make(map[[32]byte]*remoteSession)
	}
	return m.issuePairLocked()
}

// rotate retains the old desktop action's revoke-all semantics for callers.
func (m *remoteAccessManager) rotate() error { return m.newPair(true) }

func (m *remoteAccessManager) shutdown() {
	m.mu.Lock()
	server := m.server
	m.server = nil
	m.pairToken = ""
	m.pairURL = ""
	m.sessions = nil
	m.mu.Unlock()
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
}

func sessionKey(token string) [32]byte { return sha256.Sum256([]byte(token)) }

func deviceLabel(userAgent string) string {
	label := strings.TrimSpace(userAgent)
	if label == "" {
		return "Unknown phone browser"
	}
	if len(label) > 96 {
		label = label[:96]
	}
	return label
}

func (m *remoteAccessManager) consumePair(token, userAgent string) (string, *remoteSession, bool) {
	sessionToken, err := randomToken(32)
	if err != nil {
		return "", nil, false
	}
	sessionID, err := randomToken(12)
	if err != nil {
		return "", nil, false
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if token == "" || m.pairToken == "" || now.After(m.pairExpiresAt) || subtle.ConstantTimeCompare([]byte(token), []byte(m.pairToken)) != 1 {
		return "", nil, false
	}
	m.pairToken = ""
	m.pairURL = ""
	m.pairExpiresAt = time.Time{}
	if m.sessions == nil {
		m.sessions = make(map[[32]byte]*remoteSession)
	}
	session := &remoteSession{ID: sessionID, Device: deviceLabel(userAgent), CreatedAt: now, LastSeen: now, ExpiresAt: now.Add(remoteSessionTTL)}
	m.sessions[sessionKey(sessionToken)] = session
	copy := *session
	return sessionToken, &copy, true
}

func (m *remoteAccessManager) authenticateSession(token string) bool {
	if token == "" {
		return false
	}
	now := time.Now()
	key := sessionKey(token)
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[key]
	if !ok {
		return false
	}
	if now.After(session.ExpiresAt) {
		delete(m.sessions, key)
		return false
	}
	session.LastSeen = now
	return true
}

func (m *remoteAccessManager) revokeSession(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, session := range m.sessions {
		if session.ID == id {
			delete(m.sessions, key)
			return true
		}
	}
	return false
}

func (m *remoteAccessManager) revokeAll() {
	m.mu.Lock()
	m.sessions = make(map[[32]byte]*remoteSession)
	m.mu.Unlock()
}

func (m *remoteAccessManager) status(remote bool) remoteAccessStatus {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	client := "desktop"
	capabilities := []string{"desktop"}
	if remote {
		client = "phone"
		capabilities = remoteCapabilityIDs()
	}
	result := remoteAccessStatus{Enabled: m.server != nil, Remote: remote, Client: client, Capabilities: capabilities, DisplayURL: m.displayURL, Port: m.port, SessionExpiresIn: int(remoteSessionTTL.Seconds())}
	for key, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, key)
			continue
		}
		if !remote {
			result.Sessions = append(result.Sessions, *session)
		}
	}
	result.PairingAvailable = m.pairToken != "" && now.Before(m.pairExpiresAt)
	if result.PairingAvailable && !remote {
		result.URL = m.pairURL
		result.ExpiresAt = m.pairExpiresAt.UTC().Format(time.RFC3339)
	}
	return result
}

func (m *remoteAccessManager) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if pair := r.URL.Query().Get("pair"); pair != "" {
			// Camera apps and mobile browsers may retry the QR URL after the
			// redirect. If this browser already has a valid session, make that
			// retry idempotent without making the QR token reusable for a new
			// device.
			if cookie, cookieErr := r.Cookie(remoteCookie); cookieErr == nil && m.authenticateSession(cookie.Value) {
				redirectWithoutPair(w, r)
				return
			}
			sessionToken, session, ok := m.consumePair(pair, r.UserAgent())
			if !ok {
				http.Error(w, "This RiftOps pairing link has expired, was already used, or is invalid.", http.StatusUnauthorized)
				return
			}
			m.setCookie(w, sessionToken, session.ExpiresAt)
			redirectWithoutPair(w, r)
			return
		}

		cookie, err := r.Cookie(remoteCookie)
		if err != nil || !m.authenticateSession(cookie.Value) {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, "Scan a fresh RiftOps QR code to pair this device.", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), remoteRequestKey{}, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func redirectWithoutPair(w http.ResponseWriter, r *http.Request) {
	clean := *r.URL
	query := clean.Query()
	query.Del("pair")
	clean.RawQuery = query.Encode()
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, clean.String(), http.StatusFound)
}

func (m *remoteAccessManager) setCookie(w http.ResponseWriter, token string, expiresAt time.Time) {
	// Lax allows the QR link's external camera-app navigation to complete on
	// mobile browsers. Mutating requests still require an exact Origin in
	// originCheck, so this does not make the LAN API cross-site writable.
	http.SetCookie(w, &http.Cookie{Name: remoteCookie, Value: token, Path: "/", MaxAge: max(1, int(time.Until(expiresAt).Seconds())), Expires: expiresAt, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func remoteRequest(r *http.Request) bool {
	value, _ := r.Context().Value(remoteRequestKey{}).(bool)
	return value
}

type remoteCapability struct {
	ID     string
	Routes map[string][]string
}

// remoteCapabilities is the phone product contract. Keeping routes in named
// groups makes every permission reviewable and prevents a paired phone from
// inheriting new desktop endpoints by accident. Full settings, saved sessions,
// diagnostics, settings/restore, loot/rewards, rune/item CRUD, profile
// mutation, updates, app quit, and presence-engine controls intentionally do
// not appear here. Safe preset application and replay/lobby controls are
// explicitly listed below and remain bounded by their typed handlers.
var remoteCapabilities = []remoteCapability{
	{ID: "session_state", Routes: map[string][]string{
		"/api/snapshot": {http.MethodGet}, "/api/events": {http.MethodGet}, "/api/remote/status": {http.MethodGet},
		"/api/ddragon/version": {http.MethodGet}, "/api/ddragon/champions": {http.MethodGet}, "/api/ddragon/profile-icons": {http.MethodGet},
		"/api/lcu/status": {http.MethodGet}, "/api/lcu/overview": {http.MethodGet}, "/api/lcu/profile": {http.MethodGet},
		"/api/lcu/active-game": {http.MethodGet},
		"/api/lcu/friends":     {http.MethodGet}, "/api/lcu/social": {http.MethodGet}, "/api/lcu/health": {http.MethodGet}, "/api/lcu/server-status": {http.MethodGet},
	}},
	{ID: "social_control", Routes: map[string][]string{
		"/api/lcu/friend-request-action": {http.MethodPost}, "/api/lcu/social-invite": {http.MethodPost},
	}},
	{ID: "match_history_read", Routes: map[string][]string{
		"/api/lcu/match-history": {http.MethodGet}, "/api/lcu/game-detail": {http.MethodGet}, "/api/lcu/champ-select/runes/catalog": {http.MethodGet},
	}},
	{ID: "collection_read", Routes: map[string][]string{
		"/api/lcu/skins": {http.MethodGet}, "/api/lcu/background-champions": {http.MethodGet}, "/api/lcu/background-skins": {http.MethodGet},
	}},
	{ID: "preset_apply", Routes: map[string][]string{
		"/api/profile-presets": {http.MethodGet}, "/api/profile-presets/preview": {http.MethodPost}, "/api/profile-presets/apply": {http.MethodPost},
		"/api/lcu/preparation-presets": {http.MethodGet}, "/api/lcu/preparation-presets/preview": {http.MethodPost}, "/api/lcu/preparation-presets/apply": {http.MethodPost},
		"/api/lcu/lobby-presets": {http.MethodGet}, "/api/lcu/lobby-presets/preview": {http.MethodPost}, "/api/lcu/lobby-presets/apply": {http.MethodPost},
	}},
	{ID: "quick_lobby", Routes: map[string][]string{
		"/api/lcu/custom-bots":     {http.MethodGet, http.MethodPost},
		"/api/lcu/custom-bots/add": {http.MethodPost},
	}},
	{ID: "replay_control", Routes: map[string][]string{
		"/api/lcu/replay":          {http.MethodGet, http.MethodPost},
		"/api/lcu/replay-status":   {http.MethodGet},
		"/api/lcu/replay/download": {http.MethodPost},
		"/api/lcu/replay/watch":    {http.MethodPost},
	}},
	{ID: "lobby_control", Routes: map[string][]string{
		"/api/lcu/lobby": {http.MethodGet}, "/api/lcu/available-queues": {http.MethodGet}, "/api/lcu/create-lobby": {http.MethodPost},
		"/api/lcu/auto-roles": {http.MethodPost}, "/api/lcu/auto-requeue": {http.MethodPost}, "/api/lcu/stop-queue": {http.MethodPost},
		"/api/lcu/quit-custom": {http.MethodPost}, "/api/lcu/custom-start": {http.MethodPost},
	}},
	{ID: "ready_check", Routes: map[string][]string{
		"/api/lcu/auto-accept": {http.MethodPost}, "/api/lcu/decline-ready": {http.MethodPost},
	}},
	{ID: "champion_select", Routes: map[string][]string{
		"/api/lcu/gameflow-phase": {http.MethodGet}, "/api/lcu/champ-select": {http.MethodGet},
		"/api/lcu/champ-select/pickable": {http.MethodGet}, "/api/lcu/champ-select/bannable": {http.MethodGet}, "/api/lcu/champ-select/skins": {http.MethodGet},
		"/api/lcu/champ-select/pick-order-swaps": {http.MethodGet}, "/api/lcu/champ-select/position-swaps": {http.MethodGet},
		"/api/lcu/champ-select/action": {http.MethodPost}, "/api/lcu/champ-select/selection": {http.MethodPatch, http.MethodPost},
		"/api/lcu/champ-select/reroll": {http.MethodPost}, "/api/lcu/champ-select/bench/swap": {http.MethodPost},
		"/api/lcu/champ-select/pick-order-swap": {http.MethodPost}, "/api/lcu/champ-select/position-swap": {http.MethodPost}, "/api/lcu/dodge": {http.MethodPost},
	}},
	{ID: "rune_select", Routes: map[string][]string{
		"/api/lcu/champ-select/runes": {http.MethodGet}, "/api/lcu/champ-select/runes/select": {http.MethodPost},
	}},
	{ID: "presence", Routes: map[string][]string{
		"/api/lcu/availability": {http.MethodPost}, "/api/lcu/status-message": {http.MethodPost},
	}},
	{ID: "post_game", Routes: map[string][]string{
		"/api/lcu/honor-ballot": {http.MethodGet}, "/api/lcu/honor-player": {http.MethodPost},
		"/api/lcu/play-again": {http.MethodPost}, "/api/lcu/claim-event-rewards": {http.MethodPost},
	}},
	{ID: "remote_launch", Routes: map[string][]string{
		"/api/lcu/launch-league": {http.MethodPost},
	}},
}

func remoteCapabilityIDs() []string {
	ids := make([]string, 0, len(remoteCapabilities))
	for _, capability := range remoteCapabilities {
		ids = append(ids, capability.ID)
	}
	return ids
}

func buildRemoteAPIMethods() map[string]map[string]bool {
	result := make(map[string]map[string]bool)
	for _, capability := range remoteCapabilities {
		for path, methods := range capability.Routes {
			if result[path] == nil {
				result[path] = make(map[string]bool)
			}
			for _, method := range methods {
				result[path][method] = true
			}
		}
	}
	return result
}

var remoteAPIMethods = buildRemoteAPIMethods()

func remoteRouteScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || (!strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/lol-game-data/")) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(path, "/lol-game-data/") {
			if r.Method != http.MethodGet || !remoteAssetPathAllowed(path) {
				if r.Method == http.MethodGet {
					http.Error(w, "This asset is not available to paired phones.", http.StatusForbidden)
					return
				}
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		methods, allowed := remoteAPIMethods[path]
		if !allowed {
			http.Error(w, "This desktop-only endpoint is not available to paired phones.", http.StatusForbidden)
			return
		}
		if !methods[r.Method] {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func remoteAssetPathAllowed(path string) bool {
	if len(path) > 512 || !strings.HasPrefix(path, "/lol-game-data/assets/") || strings.Contains(path, "\\") || strings.Contains(path, "..") {
		return false
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".json", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg":
		return true
	default:
		return false
	}
}

func remoteSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		// Some existing League views use Riot's public Data Dragon catalogue
		// directly for splash/profile/champion assets. Permit only those known
		// read-only asset hosts; API/data mutations remain same-origin.
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https://ddragon.leagueoflegends.com https://raw.communitydragon.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://ddragon.leagueoflegends.com")
		next.ServeHTTP(w, r)
	})
}

func remoteStatusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(remoteAccess.status(remoteRequest(r)))
}

func remoteQRHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if remoteRequest(r) {
		http.Error(w, "QR generation is available from the desktop dashboard.", http.StatusNotFound)
		return
	}
	status := remoteAccess.status(false)
	if !status.Enabled || !status.PairingAvailable || status.URL == "" {
		http.Error(w, "Generate a fresh pairing code first.", http.StatusServiceUnavailable)
		return
	}
	image, err := qrcode.Encode(status.URL, qrcode.Medium, 512)
	if err != nil {
		http.Error(w, "Could not generate pairing QR code.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(image)
}

func remoteRotateHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		http.Error(w, "Only the desktop can regenerate pairing access.", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := remoteAccess.newPair(false); err != nil {
		http.Error(w, "Phone control is unavailable.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(remoteAccess.status(false))
}

func remoteRevokeHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		http.Error(w, "Only the desktop can revoke phone sessions.", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
		http.Error(w, "Invalid session", http.StatusBadRequest)
		return
	}
	if !remoteAccess.revokeSession(body.ID) {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(remoteAccess.status(false))
}

func remoteRevokeAllHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		http.Error(w, "Only the desktop can revoke phone sessions.", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	remoteAccess.revokeAll()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(remoteAccess.status(false))
}

func remoteEnableHandler(w http.ResponseWriter, r *http.Request) {
	if remoteRequest(r) {
		http.Error(w, "Only the desktop can change phone access.", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid phone access request", http.StatusBadRequest)
		return
	}
	if err := backendEngine.SavePhoneAccess(body.Enabled); err != nil {
		http.Error(w, "Could not save the phone access setting", http.StatusInternalServerError)
		slog.Error("save phone access setting", "error", err)
		return
	}
	if body.Enabled {
		if handler, ok := dashboardMux.Load().(*http.ServeMux); ok && handler != nil {
			startRemoteAccess(handler)
		} else {
			http.Error(w, "Phone control is unavailable right now.", http.StatusServiceUnavailable)
			return
		}
	} else {
		stopRemoteAccess()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(remoteAccess.status(false))
}

func listenRemotePort(host string) (net.Listener, int, error) {
	var lastErr error
	for port := remotePortStart; port <= remotePortEnd; port++ {
		listener, err := net.Listen("tcp4", net.JoinHostPort(host, strconv.Itoa(port)))
		if err == nil {
			return listener, port, nil
		}
		lastErr = err
	}
	return nil, 0, fmt.Errorf("mobile listener unavailable on ports %d-%d: %w", remotePortStart, remotePortEnd, lastErr)
}

func localLANAddress() string {
	if address := routedInterfaceAddress(); address != "" {
		return address
	}
	return enumeratedLANAddress()
}

func routedInterfaceAddress() string {
	conn, err := net.Dial("udp", "93.184.216.34:53")
	if err != nil {
		return ""
	}
	defer conn.Close()
	address, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || address.IP == nil {
		return ""
	}
	ip := address.IP.To4()
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || !isPrivateIPv4(ip) {
		return ""
	}
	return ip.String()
}

func enumeratedLANAddress() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			var ip net.IP
			switch value := address.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip = ip.To4(); ip != nil && !ip.IsLoopback() && !ip.IsUnspecified() && isPrivateIPv4(ip) {
				return ip.String()
			}
		}
	}
	return ""
}

func isPrivateIPv4(ip net.IP) bool {
	return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168)
}
