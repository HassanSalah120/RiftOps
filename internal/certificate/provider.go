package certificate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

//go:embed localhostCert.pfx
var embeddedPFX []byte

const MaxPFXBytes = 2 << 20

type Provider struct {
	CachePath   string
	URL         string
	Hostname    string
	MinValidFor time.Duration
	Client      *http.Client
}

func (p Provider) Load(ctx context.Context) (tls.Certificate, error) {
	if p.MinValidFor == 0 {
		p.MinValidFor = 14 * 24 * time.Hour
	}
	// 1. Try cache first
	if p.CachePath != "" {
		if cached, err := os.ReadFile(p.CachePath); err == nil {
			if certificate, err := p.decodeAndValidate(cached); err == nil {
				if p.URL != "" && time.Until(certificate.Leaf.NotAfter) < 20*24*time.Hour {
					p.triggerBackgroundRefresh()
				}
				return certificate, nil
			}
			_ = os.Remove(p.CachePath) // stale cache, discard
		}
	}

	// 2. Try embedded bundle if valid for target hostname
	if len(embeddedPFX) > 0 {
		if certificate, err := p.decodeAndValidate(embeddedPFX); err == nil {
			if p.CachePath != "" {
				_ = writePrivateFile(p.CachePath, embeddedPFX)
			}
			if p.URL != "" && time.Until(certificate.Leaf.NotAfter) < 20*24*time.Hour {
				p.triggerBackgroundRefresh()
			}
			return certificate, nil
		}
	}

	// 3. Try download if URL provided and network is available
	if p.URL != "" {
		dlCtx, dlCancel := context.WithTimeout(ctx, 3*time.Second)
		defer dlCancel()
		if cert, err := p.download(dlCtx); err == nil {
			return cert, nil
		}
	}

	// 4. Always produce a local certificate immediately as reliable fallback.
	cert, err := p.generateSelfSigned()
	if err != nil {
		return tls.Certificate{}, err
	}
	return cert, nil
}

func (p Provider) triggerBackgroundRefresh() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := p.download(ctx); err != nil {
			slog.Debug("background cert refresh skipped", "error", err)
			return
		}
		slog.Info("downloaded and refreshed proxy certificate cache")
	}()
}

func (p Provider) download(ctx context.Context) (tls.Certificate, error) {
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create cert request: %w", err)
	}
	request.Header.Set("User-Agent", "RiftOps")
	response, err := client.Do(request)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("download proxy certificate: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return tls.Certificate{}, fmt.Errorf("certificate server returned %s", response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxPFXBytes+1))
	if err != nil || len(data) > MaxPFXBytes {
		return tls.Certificate{}, errors.New("certificate response was invalid or too large")
	}
	certificate, err := p.decodeAndValidate(data)
	if err != nil {
		return tls.Certificate{}, err
	}
	if p.CachePath != "" {
		if err := writePrivateFile(p.CachePath, data); err != nil {
			slog.Warn("could not cache downloaded certificate", "error", err)
		}
	}
	return certificate, nil
}

// generateSelfSigned creates a short-lived local CA and an ECDSA leaf
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
		return tls.Certificate{}, fmt.Errorf("generate local chat CA key: %w", err)
	}
	caSerial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local chat CA serial: %w", err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber: caSerial,
		Subject: pkix.Name{
			Organization: []string{"RiftOps"},
			CommonName:   "RiftOps Local Chat CA",
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
		return tls.Certificate{}, fmt.Errorf("create local chat CA: %w", err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse local chat CA: %w", err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local chat leaf key: %w", err)
	}
	leafSerial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate local chat leaf serial: %w", err)
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
		return tls.Certificate{}, fmt.Errorf("create local chat leaf: %w", err)
	}
	leaf, err := x509.ParseCertificate(certDER)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse local chat leaf: %w", err)
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
