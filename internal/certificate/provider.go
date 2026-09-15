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
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return tls.Certificate{}, ctx.Err()
	default:
	}
	if p.MinValidFor == 0 {
		p.MinValidFor = 14 * 24 * time.Hour
	}
	// 1. Try cache first
	if p.CachePath != "" {
		if cached, err := os.ReadFile(p.CachePath); err == nil {
			if certificate, err := p.decodeAndValidate(cached); err == nil {
				return certificate, nil
			}
			_ = os.Remove(p.CachePath) // stale cache, discard
		}
	}

	// Release builds may carry a certificate for RiftOps' fixed local
	// hostname. Validate it through the same path as a user-provisioned cache;
	// if it is absent or does not match, keep the development fallback below.
	if certificate, err := LoadBundled(ctx, p.Hostname); err == nil {
		return certificate, nil
	}

	// Generate a local certificate when no valid cache exists. It never depends
	// on an external certificate URL or a machine-wide trust-store mutation.
	cert, err := p.generateSelfSigned()
	if err != nil {
		return tls.Certificate{}, err
	}
	return cert, nil
}

// LoadCached reads only the configured certificate cache. Unlike Load it does
// not generate a fallback certificate, which is important for setup status:
// callers must not report a trusted public certificate when only the local
// self-signed fallback exists.
func (p Provider) LoadCached(ctx context.Context) (tls.Certificate, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return tls.Certificate{}, ctx.Err()
	default:
	}
	if p.CachePath == "" {
		return tls.Certificate{}, errors.New("certificate cache path is required")
	}
	data, err := os.ReadFile(p.CachePath)
	if err != nil {
		return tls.Certificate{}, err
	}
	return p.decodeAndValidate(data)
}

// generateSelfSigned creates a local CA and an ECDSA leaf
// certificate signed by that CA. Riot's current chat stack requires a valid
// CA chain and does not accept a self-signed server leaf, even when the
// compatibility flag is present.
func (p Provider) generateSelfSigned() (tls.Certificate, error) {
	hostname := p.Hostname
	if hostname == "" {
		hostname = "127.0.0.1"
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local certificate CA key: %w", err)
	}
	caSerial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local certificate CA serial: %w", err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber: caSerial,
		Subject: pkix.Name{
			Organization: []string{"RiftOps"},
			CommonName:   "RiftOps Local Certificate CA",
		},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(5 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create local certificate CA: %w", err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse local certificate CA: %w", err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local certificate leaf key: %w", err)
	}
	leafSerial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local certificate leaf serial: %w", err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: leafSerial,
		Subject: pkix.Name{
			Organization: []string{"RiftOps"},
			CommonName:   hostname,
		},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		AuthorityKeyId:        caCertificate.SubjectKeyId,
	}
	if ip := net.ParseIP(hostname); ip != nil {
		leafTemplate.IPAddresses = []net.IP{ip}
	} else {
		leafTemplate.DNSNames = []string{hostname}
	}
	certDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCertificate, &leafKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create local certificate leaf: %w", err)
	}
	leaf, err := x509.ParseCertificate(certDER)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse local certificate leaf: %w", err)
	}
	certificate := tls.Certificate{
		Certificate: [][]byte{certDER, caDER},
		PrivateKey:  leafKey,
		Leaf:        leaf,
	}
	// Cache the leaf key and certificate chain as PKCS#12 so subsequent starts
	// can reuse the same local identity without touching the machine trust store.
	pfxData, err := pkcs12.Encode(rand.Reader, leafKey, leaf, []*x509.Certificate{caCertificate}, "")
	if err != nil {
		slog.Warn("could not cache local certificate as PKCS#12", "error", err)
	} else if p.CachePath != "" {
		if err := writePrivateFile(p.CachePath, pfxData); err != nil {
			slog.Warn("could not write local certificate cache", "error", err)
		}
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
	if p.Hostname != "" {
		if err := leaf.VerifyHostname(p.Hostname); err != nil {
			return tls.Certificate{}, fmt.Errorf("certificate hostname: %w", err)
		}
	}
	if len(chain) == 0 || chain[0] == nil || !chain[0].IsCA {
		return tls.Certificate{}, errors.New("certificate has no valid local issuing CA")
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

// SavePKCS12 stores a certificate and its private key in the same protected
// cache format used by Provider. The caller is responsible for obtaining the
// certificate from a trusted source and for keeping the key local.
func SavePKCS12(path string, privateKey any, leaf *x509.Certificate, chain []*x509.Certificate) error {
	if path == "" {
		return errors.New("certificate cache path is required")
	}
	if privateKey == nil || leaf == nil {
		return errors.New("certificate private key and leaf are required")
	}
	if len(chain) == 0 {
		return errors.New("certificate issuer chain is required")
	}
	data, err := pkcs12.Encode(rand.Reader, privateKey, leaf, chain, "")
	if err != nil {
		return fmt.Errorf("encode certificate cache: %w", err)
	}
	if err := writePrivateFile(path, data); err != nil {
		return fmt.Errorf("write certificate cache: %w", err)
	}
	return nil
}

// ValidatePKCS12File validates a certificate that is about to be bundled into
// a release. It deliberately returns no certificate material to callers.
func ValidatePKCS12File(path, hostname string) error {
	if path == "" {
		return errors.New("certificate path is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read certificate: %w", err)
	}
	if _, err := (Provider{Hostname: hostname}).decodeAndValidate(data); err != nil {
		return fmt.Errorf("validate certificate: %w", err)
	}
	return nil
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
	return filepath.Join(dir, "RiftOps", "chatCert.pfx"), nil
}

func VerifyLeaf(certificate tls.Certificate, roots *x509.CertPool, hostname string) error {
	if certificate.Leaf == nil {
		return errors.New("missing parsed leaf certificate")
	}
	_, err := certificate.Leaf.Verify(x509.VerifyOptions{DNSName: hostname, Roots: roots})
	return err
}
