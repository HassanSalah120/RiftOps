package certificate

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"path/filepath"
	"testing"
	"time"

	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

func makePFX(t *testing.T, hostname string, notAfter time.Time) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: hostname}, DNSNames: []string{hostname},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := pkcs12.Encode(rand.Reader, key, certificate, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestProviderGeneratesValidatesAndCaches(t *testing.T) {
	const hostname = "riftops-localhost.example.test"
	cache := filepath.Join(t.TempDir(), "cache", "localhost.pfx")
	provider := Provider{CachePath: cache, Hostname: hostname}
	certificate, err := provider.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if certificate.Leaf == nil || certificate.Leaf.DNSNames[0] != hostname {
		t.Fatalf("unexpected certificate: %+v", certificate.Leaf)
	}
	if len(certificate.Certificate) < 2 {
		t.Fatal("generated certificate did not include its issuing CA")
	}
	if len(certificate.Leaf.AuthorityKeyId) == 0 {
		t.Fatal("generated leaf did not include an authority key identifier")
	}
	if _, err := (Provider{CachePath: cache, Hostname: hostname}).Load(context.Background()); err != nil {
		t.Fatalf("cached certificate was not reusable: %v", err)
	}
}

func TestProviderGeneratesLoopbackIPCertificate(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache", "localhost.pfx")
	certificate, err := (Provider{CachePath: cache, Hostname: "127.0.0.1"}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if certificate.Leaf == nil || len(certificate.Leaf.IPAddresses) != 1 || !certificate.Leaf.IPAddresses[0].Equal(net.ParseIP("127.0.0.1")) {
		t.Fatalf("generated certificate has no loopback IP SAN: %+v", certificate.Leaf)
	}
	if len(certificate.Certificate) < 2 {
		t.Fatal("generated loopback certificate did not include its issuing CA")
	}
}

func TestProviderGeneratesLocalhostDNSCertificate(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache", "localhost.pfx")
	certificate, err := (Provider{CachePath: cache, Hostname: "localhost"}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if certificate.Leaf == nil || len(certificate.Leaf.DNSNames) != 1 || certificate.Leaf.DNSNames[0] != "localhost" {
		t.Fatalf("generated certificate has no localhost DNS SAN: %+v", certificate.Leaf)
	}
	if err := certificate.Leaf.VerifyHostname("localhost"); err != nil {
		t.Fatalf("generated certificate does not verify localhost: %v", err)
	}
}

func TestProviderRejectsWrongHostnameAndExpiringCertificate(t *testing.T) {
	provider := Provider{Hostname: "expected.example.test", MinValidFor: 20 * 24 * time.Hour}
	wrongHost := makePFX(t, "wrong.example.test", time.Now().Add(90*24*time.Hour))
	if _, err := provider.decodeAndValidate(wrongHost); err == nil {
		t.Fatal("wrong hostname was accepted")
	}
	expiring := makePFX(t, "expected.example.test", time.Now().Add(5*24*time.Hour))
	if _, err := provider.decodeAndValidate(expiring); err == nil {
		t.Fatal("expiring certificate was accepted")
	}
}
