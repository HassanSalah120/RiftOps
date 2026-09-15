package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/engine"
)

func proxyStatusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	status := backendEngine.ProxyStatus(r.Context())
	writeProxyStatus(w, status)
}

func proxySetupHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Hostname string `json:"hostname"`
		Token    string `json:"token"`
		Email    string `json:"email"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	if err := decoder.Decode(&body); err != nil {
		httpError(w, "Invalid proxy setup request", http.StatusBadRequest)
		return
	}
	body.Hostname = strings.TrimSpace(body.Hostname)
	body.Email = strings.TrimSpace(body.Email)
	if body.Hostname == "" || body.Token == "" {
		httpError(w, "Enter the DuckDNS hostname and token locally", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Minute)
	defer cancel()
	status, err := backendEngine.ConfigureProxy(ctx, body.Hostname, body.Token, body.Email)
	if err != nil {
		// Never log or return the request body: it contains the DuckDNS token.
		httpError(w, "Trusted local chat setup failed: "+safeProxyError(err), http.StatusBadGateway)
		return
	}
	writeProxyStatus(w, status)
}

func proxyClearHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		httpError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := backendEngine.ClearProxy(); err != nil {
		httpError(w, "Could not remove the RiftOps local hostname entry", http.StatusInternalServerError)
		return
	}
	writeProxyStatus(w, backendEngine.ProxyStatus(r.Context()))
}

func writeProxyStatus(w http.ResponseWriter, status engine.ProxyStatus) {
	// Keep this response deliberately small: never expose certificate paths,
	// account keys, DNS tokens, or private key material to the frontend.
	response := map[string]any{
		"configured":       status.Configured,
		"hostname":         status.Hostname,
		"certificateReady": status.CertificateOK,
		"loopbackReady":    status.LoopbackReady,
		"mode":             status.Mode,
	}
	if !status.ExpiresAt.IsZero() {
		response["expiresAt"] = status.ExpiresAt.UTC().Format(time.RFC3339)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

func safeProxyError(err error) string {
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return "unknown error"
	}
	return message
}
