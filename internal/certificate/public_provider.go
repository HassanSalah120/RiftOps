package certificate

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultPublicBundleURL = "https://backloop.dev/pack.json"
	maxPublicBundleBytes   = 1 << 20
)

// PublicProvider loads a publicly trusted certificate for a DNS name that
// resolves only to loopback. The key is intentionally public: it is used only
// to terminate a connection on the user's own machine, while the proxy creates
// a separate authenticated TLS connection to Riot.
type PublicProvider struct {
	CachePath   string
	Hostname    string
	BundleURL   string
	MinValidFor time.Duration
	HTTPClient  *http.Client
	Roots       *x509.CertPool
	allowHTTP   bool
}

type publicBundle struct {
	Domain string `json:"domain"`
	Cert   string `json:"cert"`
	CA     string `json:"ca"`
	Key1   string `json:"key1"`
	Key2   string `json:"key2"`
}

func (p PublicProvider) Load(ctx context.Context) (tls.Certificate, error) {
	if strings.TrimSpace(p.Hostname) == "" {
		return tls.Certificate{}, errors.New("public loopback certificate hostname is required")
	}
	if p.BundleURL == "" {
		p.BundleURL = DefaultPublicBundleURL
	}
	if p.MinValidFor == 0 {
		p.MinValidFor = 14 * 24 * time.Hour
	}
	roots := p.Roots
	if roots == nil {
		var err error
		roots, err = x509.SystemCertPool()
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("load system certificate roots: %w", err)
		}
	}

	var cached []byte
	if p.CachePath != "" {
		cached, _ = os.ReadFile(p.CachePath)
		if certificate, err := decodePublicBundle(cached, p.Hostname, p.MinValidFor, roots); err == nil {
			return certificate, nil
		}
	}

	fresh, fetchErr := p.fetch(ctx)
	if fetchErr == nil {
		certificate, decodeErr := decodePublicBundle(fresh, p.Hostname, p.MinValidFor, roots)
		if decodeErr == nil {
			if p.CachePath != "" {
				_ = writePrivateFile(p.CachePath, fresh)
			}
			return certificate, nil
		}
		fetchErr = decodeErr
	}

	// A refresh failure should not discard a still-valid cached certificate.
	// Revalidate with only a short safety window before falling back to direct
	// Riot chat.
	if len(cached) > 0 {
		if certificate, err := decodePublicBundle(cached, p.Hostname, time.Hour, roots); err == nil {
			return certificate, nil
		}
	}
	return tls.Certificate{}, fmt.Errorf("load public loopback certificate: %w", fetchErr)
}

func (p PublicProvider) fetch(ctx context.Context) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, p.BundleURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create certificate request: %w", err)
	}
	if request.URL.Scheme != "https" && !p.allowHTTP {
		return nil, fmt.Errorf("certificate bundle URL must use HTTPS, got %q", request.URL.Scheme)
	}
	client := p.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download certificate bundle: %w", err)
	}
	defer response.Body.Close()
	if response.Request == nil || (response.Request.URL.Scheme != "https" && !p.allowHTTP) {
		return nil, errors.New("certificate bundle download redirected away from HTTPS")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download certificate bundle: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPublicBundleBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read certificate bundle: %w", err)
	}
	if len(data) > maxPublicBundleBytes {
		return nil, errors.New("certificate bundle is too large")
	}
	return data, nil
}

func decodePublicBundle(data []byte, hostname string, minValidFor time.Duration, roots *x509.CertPool) (tls.Certificate, error) {
	if len(data) == 0 {
		return tls.Certificate{}, errors.New("certificate bundle is empty")
	}
	var bundle publicBundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		return tls.Certificate{}, fmt.Errorf("decode certificate bundle: %w", err)
	}
	if bundle.Domain != "backloop.dev" {
		return tls.Certificate{}, fmt.Errorf("unexpected certificate bundle domain %q", bundle.Domain)
	}
	if !strings.HasSuffix(strings.ToLower(hostname), ".backloop.dev") {
		return tls.Certificate{}, fmt.Errorf("hostname %q is outside backloop.dev", hostname)
	}
	certificatePEM := []byte(bundle.Cert + "\n" + bundle.CA)
	privateKeyPEM := []byte(bundle.Key1 + bundle.Key2)
	certificate, err := tls.X509KeyPair(certificatePEM, privateKeyPEM)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse certificate bundle: %w", err)
	}
	if len(certificate.Certificate) == 0 {
		return tls.Certificate{}, errors.New("certificate bundle has no leaf")
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse certificate leaf: %w", err)
	}
	if err := leaf.VerifyHostname(hostname); err != nil {
		return tls.Certificate{}, fmt.Errorf("certificate hostname: %w", err)
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || leaf.NotAfter.Before(now.Add(minValidFor)) {
		return tls.Certificate{}, fmt.Errorf("certificate validity window is unacceptable: %s to %s", leaf.NotBefore, leaf.NotAfter)
	}
	intermediates := x509.NewCertPool()
	for _, raw := range certificate.Certificate[1:] {
		issuer, parseErr := x509.ParseCertificate(raw)
		if parseErr != nil {
			return tls.Certificate{}, fmt.Errorf("parse certificate issuer: %w", parseErr)
		}
		intermediates.AddCert(issuer)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		DNSName: hostname, Roots: roots, Intermediates: intermediates,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		return tls.Certificate{}, fmt.Errorf("verify public certificate chain: %w", err)
	}
	certificate.Leaf = leaf
	return certificate, nil
}

func DefaultPublicBundleCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "RiftOps", "loopback-certificate.json"), nil
}
