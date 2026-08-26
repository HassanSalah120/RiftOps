package certificate

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testPublicBundle(t *testing.T, hostname string) ([]byte, *x509.CertPool) {
	t.Helper()
	generated, err := (Provider{Hostname: hostname}).generateSelfSigned()
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(generated.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	bundle := publicBundle{
		Domain: "backloop.dev",
		Cert:   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: generated.Certificate[0]})),
		CA:     string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: generated.Certificate[1]})),
		Key1:   string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})),
	}
	data, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	issuer, err := x509.ParseCertificate(generated.Certificate[1])
	if err != nil {
		t.Fatal(err)
	}
	roots.AddCert(issuer)
	return data, roots
}

func TestDecodePublicBundleValidatesHostnameAndChain(t *testing.T) {
	const hostname = "riftops.backloop.dev"
	data, roots := testPublicBundle(t, hostname)
	certificate, err := decodePublicBundle(data, hostname, 24*time.Hour, roots)
	if err != nil {
		t.Fatal(err)
	}
	if certificate.Leaf == nil || certificate.Leaf.Subject.CommonName != hostname {
		t.Fatalf("leaf = %+v", certificate.Leaf)
	}
	if _, err := decodePublicBundle(data, "other.backloop.dev", 24*time.Hour, roots); err == nil {
		t.Fatal("bundle was accepted for the wrong hostname")
	}
}

func TestPublicProviderCachesValidatedBundle(t *testing.T) {
	const hostname = "riftops.backloop.dev"
	data, roots := testPublicBundle(t, hostname)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write(data)
	}))
	defer server.Close()

	provider := PublicProvider{
		CachePath: filepath.Join(t.TempDir(), "bundle.json"), Hostname: hostname,
		BundleURL: server.URL, HTTPClient: server.Client(), Roots: roots,
		MinValidFor: 24 * time.Hour, allowHTTP: true,
	}
	if _, err := provider.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	provider.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, io.ErrUnexpectedEOF
	})}
	if _, err := provider.Load(context.Background()); err != nil {
		t.Fatalf("cached bundle was not reused: %v", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestPublicProviderLiveBundle(t *testing.T) {
	if os.Getenv("RIFTOPS_CERT_INTEGRATION") != "1" {
		t.Skip("set RIFTOPS_CERT_INTEGRATION=1 to validate the live public loopback bundle")
	}
	certificate, err := (PublicProvider{
		CachePath: filepath.Join(t.TempDir(), "bundle.json"),
		Hostname:  "riftops.backloop.dev",
	}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if certificate.Leaf == nil || time.Until(certificate.Leaf.NotAfter) < 14*24*time.Hour {
		t.Fatalf("live certificate is missing or too close to expiry: %+v", certificate.Leaf)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
