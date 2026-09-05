//go:build desktop

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func pairedTestManager(t *testing.T) *remoteAccessManager {
	t.Helper()
	m := &remoteAccessManager{displayURL: "http://192.168.1.10:24081", port: 24081, server: &http.Server{}, sessions: make(map[[32]byte]*remoteSession)}
	m.mu.Lock()
	if err := m.issuePairLocked(); err != nil {
		t.Fatal(err)
	}
	m.mu.Unlock()
	return m
}

func TestRemotePairIsSingleUseAndSessionTokenIsDistinct(t *testing.T) {
	m := pairedTestManager(t)
	m.mu.Lock()
	pairToken := m.pairToken
	m.mu.Unlock()
	called := false
	handler := m.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = remoteRequest(r)
		w.WriteHeader(http.StatusNoContent)
	}))

	paired := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/?pair="+pairToken, nil)
	request.Header.Set("User-Agent", "Test phone")
	handler.ServeHTTP(paired, request)
	if paired.Code != http.StatusFound {
		t.Fatalf("pairing returned %d: %s", paired.Code, paired.Body.String())
	}
	setCookie := paired.Header().Get("Set-Cookie")
	if strings.Contains(setCookie, pairToken) {
		t.Fatal("pair token was reused as the session credential")
	}
	if !strings.Contains(setCookie, remoteCookie+"=") || !strings.Contains(setCookie, "HttpOnly") || !strings.Contains(setCookie, "SameSite=Lax") {
		t.Fatalf("session cookie is not hardened: %q", setCookie)
	}

	reuse := httptest.NewRecorder()
	handler.ServeHTTP(reuse, httptest.NewRequest(http.MethodGet, "/?pair="+pairToken, nil))
	if reuse.Code != http.StatusUnauthorized {
		t.Fatalf("single-use pair token was reusable: %d", reuse.Code)
	}

	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/snapshot", nil)
	authorizedRequest.Header.Set("Cookie", strings.Split(setCookie, ";")[0])
	authorized := httptest.NewRecorder()
	handler.ServeHTTP(authorized, authorizedRequest)
	if authorized.Code != http.StatusNoContent || !called {
		t.Fatalf("phone session was not authorized: code=%d called=%v", authorized.Code, called)
	}
	// A browser retry carrying the same pair URL must not eject a session that
	// was already established by the first redirect.
	retry := httptest.NewRequest(http.MethodGet, "/?pair="+pairToken, nil)
	retry.Header.Set("Cookie", strings.Split(setCookie, ";")[0])
	retryRecorder := httptest.NewRecorder()
	handler.ServeHTTP(retryRecorder, retry)
	if retryRecorder.Code != http.StatusFound {
		t.Fatalf("valid-session QR retry was not idempotent: %d", retryRecorder.Code)
	}
}

func TestRemoteSessionExpiryAndRevocation(t *testing.T) {
	m := pairedTestManager(t)
	token := "session-secret"
	session := &remoteSession{ID: "phone-one", ExpiresAt: time.Now().Add(time.Hour)}
	m.sessions[sessionKey(token)] = session
	if !m.authenticateSession(token) {
		t.Fatal("valid session was rejected")
	}
	if !m.revokeSession(session.ID) || m.authenticateSession(token) {
		t.Fatal("revoked session remained active")
	}
	m.sessions[sessionKey(token)] = &remoteSession{ID: "expired", ExpiresAt: time.Now().Add(-time.Second)}
	if m.authenticateSession(token) {
		t.Fatal("expired session was accepted")
	}
}

func TestRemoteRouteScopeRejectsDesktopCapabilities(t *testing.T) {
	called := false
	handler := remoteRouteScope(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) }))
	for _, path := range []string{
		"/api/quit", "/api/riot-client-location", "/api/capture-session", "/api/session-status",
		"/api/preferences", "/api/check-update", "/api/skip-update", "/api/qol/preferences", "/api/lcu/loot/craft",
		"/api/lcu/champ-select/runes/page", "/api/lcu/profile-icon", "/api/diagnostics/reports",
	} {
		called = false
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusForbidden || called {
			t.Errorf("desktop endpoint %s escaped scope: code=%d called=%v", path, recorder.Code, called)
		}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/lcu/champ-select/action", nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("mobile champ-select action was blocked: %d", recorder.Code)
	}
}

func TestRemoteRouteScopeOnlyServesSafeGameAssets(t *testing.T) {
	called := false
	handler := remoteRouteScope(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, test := range []struct {
		path string
		code int
	}{
		{path: "/lol-game-data/assets/v1/champion-summary.json", code: http.StatusNoContent},
		{path: "/lol-game-data/assets/ASSETS/UX/champion.png", code: http.StatusNoContent},
		{path: "/lol-game-data/../api/preferences", code: http.StatusForbidden},
		{path: "/lol-game-data/assets/v1/secret.bin", code: http.StatusForbidden},
	} {
		called = false
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, nil))
		if recorder.Code != test.code || (test.code == http.StatusNoContent && !called) || (test.code == http.StatusForbidden && called) {
			t.Errorf("asset path %s: code=%d called=%v, want code=%d", test.path, recorder.Code, called, test.code)
		}
	}
}

func TestRemoteCapabilityManifestMatchesRegisteredRoutes(t *testing.T) {
	registered := make(map[string]bool)
	for _, route := range dashboardRoutes() {
		if route.API {
			registered[route.Pattern] = true
		}
	}
	seen := make(map[string]string)
	for _, capability := range remoteCapabilities {
		if capability.ID == "" {
			t.Fatal("remote capability has an empty ID")
		}
		for path, methods := range capability.Routes {
			if !registered[path] {
				t.Errorf("remote capability %q references unregistered route %s", capability.ID, path)
			}
			for _, method := range methods {
				key := method + " " + path
				if previous, duplicate := seen[key]; duplicate {
					t.Errorf("remote route %s belongs to both %q and %q", key, previous, capability.ID)
				}
				seen[key] = capability.ID
			}
		}
	}
	if len(seen) == 0 || len(remoteAPIMethods) == 0 {
		t.Fatal("remote capability manifest is empty")
	}
}

func TestRemoteCapabilityManifestAllowsOnlyDeclaredMethods(t *testing.T) {
	called := false
	handler := remoteRouteScope(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) }))
	for path, methods := range remoteAPIMethods {
		for method := range methods {
			called = false
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
			if recorder.Code != http.StatusNoContent || !called {
				t.Errorf("declared phone route %s %s was blocked: code=%d called=%v", method, path, recorder.Code, called)
			}
		}
		called = false
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, path, nil))
		if methods[http.MethodDelete] {
			continue
		}
		if recorder.Code != http.StatusMethodNotAllowed || called {
			t.Errorf("undeclared phone method DELETE %s escaped: code=%d called=%v", path, recorder.Code, called)
		}
	}
}

func TestRemotePairExpiry(t *testing.T) {
	m := pairedTestManager(t)
	m.mu.Lock()
	token := m.pairToken
	m.pairExpiresAt = time.Now().Add(-time.Second)
	m.mu.Unlock()
	if _, _, ok := m.consumePair(token, "phone"); ok {
		t.Fatal("expired pair token was accepted")
	}
}

func TestRemoteQRHandlerReturnsPNG(t *testing.T) {
	previous := remoteAccess
	t.Cleanup(func() { remoteAccess = previous })
	remoteAccess = pairedTestManager(t)
	recorder := httptest.NewRecorder()
	remoteQRHandler(recorder, httptest.NewRequest(http.MethodGet, "/api/remote/qr.png", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("QR handler returned %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "image/png" || recorder.Body.Len() < 100 {
		t.Fatalf("invalid QR response: type=%q bytes=%d", recorder.Header().Get("Content-Type"), recorder.Body.Len())
	}
}

func TestOriginValidationRequiresExactHTTPHost(t *testing.T) {
	for _, test := range []struct {
		origin string
		valid  bool
	}{
		{"http://192.168.1.10:24081", true}, {"https://192.168.1.10:24081", false}, {"http://192.168.1.10.evil:24081", false}, {"not a URL", false},
	} {
		if got := isSameOrigin(test.origin, "192.168.1.10:24081"); got != test.valid {
			t.Errorf("isSameOrigin(%q)=%v, want %v", test.origin, got, test.valid)
		}
	}
}

func TestRemoteMutationRequiresSameOrigin(t *testing.T) {
	called := false
	handler := originCheck(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) })
	request := httptest.NewRequest(http.MethodPost, "http://192.168.1.10:24081/api/lcu/dodge", nil)
	request = request.WithContext(context.WithValue(request.Context(), remoteRequestKey{}, true))
	missing := httptest.NewRecorder()
	handler(missing, request)
	if missing.Code != http.StatusForbidden || called {
		t.Fatalf("origin-less mutation escaped: code=%d called=%v", missing.Code, called)
	}
	request = httptest.NewRequest(http.MethodPost, "http://192.168.1.10:24081/api/lcu/dodge", nil)
	request = request.WithContext(context.WithValue(request.Context(), remoteRequestKey{}, true))
	request.Header.Set("Origin", "http://192.168.1.10:24081")
	allowed := httptest.NewRecorder()
	handler(allowed, request)
	if allowed.Code != http.StatusNoContent || !called {
		t.Fatalf("same-origin mutation was rejected: code=%d called=%v", allowed.Code, called)
	}
}

func TestRemoteStatusAndQRRequireGET(t *testing.T) {
	previous := remoteAccess
	t.Cleanup(func() { remoteAccess = previous })
	remoteAccess = &remoteAccessManager{}
	for _, handler := range []http.HandlerFunc{remoteStatusHandler, remoteQRHandler} {
		recorder := httptest.NewRecorder()
		handler(recorder, httptest.NewRequest(http.MethodPost, "/", nil))
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST returned %d", recorder.Code)
		}
	}
}

func TestRemoteStatusDoesNotExposePairingSecretsToPhone(t *testing.T) {
	m := pairedTestManager(t)
	desktop := m.status(false)
	phone := m.status(true)
	if !desktop.PairingAvailable || desktop.URL == "" || desktop.Remote {
		t.Fatalf("desktop status lost pairing details: %+v", desktop)
	}
	if !phone.Remote || phone.URL != "" || phone.ExpiresAt != "" || len(phone.Sessions) != 0 {
		t.Fatalf("phone status exposed desktop pairing/session inventory: %+v", phone)
	}
	if desktop.Client != "desktop" || len(desktop.Capabilities) != 1 || desktop.Capabilities[0] != "desktop" {
		t.Fatalf("desktop capability bootstrap is invalid: %+v", desktop)
	}
	if phone.Client != "phone" || len(phone.Capabilities) != len(remoteCapabilities) {
		t.Fatalf("phone capability bootstrap is invalid: %+v", phone)
	}
}

func TestRemoteSecurityHeadersAllowOnlyKnownAssetHosts(t *testing.T) {
	handler := remoteSecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	policy := recorder.Header().Get("Content-Security-Policy")
	for _, expected := range []string{"img-src 'self' data:", "https://ddragon.leagueoflegends.com", "https://raw.communitydragon.org", "connect-src 'self'"} {
		if !strings.Contains(policy, expected) {
			t.Errorf("CSP missing %q: %s", expected, policy)
		}
	}
	if strings.Contains(policy, "*;") || strings.Contains(policy, "https://example.com") {
		t.Errorf("CSP is broader than the known asset policy: %s", policy)
	}
	if recorder.Header().Get("Permissions-Policy") == "" || recorder.Header().Get("Cross-Origin-Opener-Policy") != "same-origin" {
		t.Errorf("remote browser hardening headers are incomplete: %v", recorder.Header())
	}
}
