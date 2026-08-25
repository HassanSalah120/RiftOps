package certificate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

type Provider struct {
	CachePath   string
	Hostname    string
	MinValidFor time.Duration
}

func (p Provider) Load(ctx context.Context) (tls.Certificate, error) {
	if p.MinValidFor == 0 {
		p.MinValidFor = 20 * 24 * time.Hour
	}
	// Try cache first
	if cached, err := os.ReadFile(p.CachePath); err == nil {
		if certificate, err := p.decodeAndValidate(cached); err == nil {
			return certificate, nil
		}
		_ = os.Remove(p.CachePath) // stale cache, discard
	}
	// Always produce a local certificate immediately. The chat proxy is
	// loopback-only and must never depend on an external certificate service.
	cert, err := p.generateSelfSigned()
	if err != nil {
		return tls.Certificate{}, err
	}
	return cert, nil
}

// generateSelfSigned creates an ECDSA self-signed certificate as a last-resort fallback.
// It caches the result so subsequent starts are fast.
func (p Provider) generateSelfSigned() (tls.Certificate, error) {
	hostname := p.Hostname
	if hostname == "" {
		hostname = "127.0.0.1"
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate self-signed key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate serial: %w", err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"RiftOps"},
			CommonName:   hostname,
		},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{hostname},
	}
	if ip := net.ParseIP(hostname); ip != nil {
		template.IPAddresses = []net.IP{ip}
	}
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create self-signed cert: %w", err)
	}
	leaf, err := x509.ParseCertificate(certDER)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse self-signed cert: %w", err)
	}
	certificate := tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  key,
		Leaf:        leaf,
	}
	// Cache the self-signed cert as PKCS#12 so subsequent starts can reuse it.
	pfxData, err := pkcs12.Encode(rand.Reader, key, leaf, nil, "")
	if err != nil {
		slog.Warn("could not cache self-signed cert as PKCS#12", "error", err)
	} else if err := writePrivateFile(p.CachePath, pfxData); err != nil {
		slog.Warn("could not write self-signed cert cache", "error", err)
	}
	return certificate, nil
}

func (p Provider) decodeAndValidate(data []byte) (tls.Certificate, error) {
	privateKey, leaf, chain, err := pkcs12.DecodeChain(data, "")
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("decode PKCS#12 certificate: %w", err)
	}
	if privateKey == nil || leaf == nil {
		return tls.Certificate{}, errors.New("certificate has no private key or leaf")
	}
	if err := leaf.VerifyHostname(p.Hostname); err != nil {
		return tls.Certificate{}, fmt.Errorf("certificate hostname: %w", err)
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || leaf.NotAfter.Before(now.Add(p.MinValidFor)) {
		return tls.Certificate{}, fmt.Errorf("certificate validity window is unacceptable: %s to %s", leaf.NotBefore, leaf.NotAfter)
	}
	certificate := tls.Certificate{PrivateKey: privateKey, Leaf: leaf, Certificate: [][]byte{leaf.Raw}}
	for _, issuer := range chain {
		certificate.Certificate = append(certificate.Certificate, issuer.Raw)
	}
	return certificate, nil
}

func writePrivateFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), "certificate-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return atomicfile.Replace(name, path)
}

func DefaultCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "RiftOps", "localhostCert.pfx"), nil
}

func VerifyLeaf(certificate tls.Certificate, roots *x509.CertPool, hostname string) error {
	if certificate.Leaf == nil {
		return errors.New("missing parsed leaf certificate")
	}
	_, err := certificate.Leaf.Verify(x509.VerifyOptions{DNSName: hostname, Roots: roots})
	return err
}
