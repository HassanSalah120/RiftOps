package certificate

import (
	"context"
	"crypto/tls"
	"errors"
	"strings"
)

var ErrBundledCertificateUnavailable = errors.New("no bundled proxy certificate is present")

// BundledHostname returns the fixed hostname used by an install-only build.
// Empty means this is a development or per-user-configured build.
func BundledHostname() string { return strings.TrimSpace(bundledHostname) }

// LoadBundled validates and loads the certificate packaged into an
// install-only build. The hostname must match the certificate SAN, so a
// bundled certificate can never be silently used for another domain.
func LoadBundled(ctx context.Context, hostname string) (tls.Certificate, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return tls.Certificate{}, ctx.Err()
	default:
	}
	if len(bundledPKCS12) == 0 || BundledHostname() == "" {
		return tls.Certificate{}, ErrBundledCertificateUnavailable
	}
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		hostname = BundledHostname()
	}
	if !strings.EqualFold(hostname, BundledHostname()) {
		return tls.Certificate{}, errors.New("bundled certificate hostname does not match requested hostname")
	}
	return (Provider{Hostname: hostname}).decodeAndValidate(bundledPKCS12)
}
