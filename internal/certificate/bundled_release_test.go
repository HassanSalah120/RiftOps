//go:build riftops_bundled_cert

package certificate

import (
	"context"
	"testing"
)

func TestBundledCertificateIsPubliclyTrusted(t *testing.T) {
	hostname := BundledHostname()
	if hostname == "" {
		t.Fatal("bundled proxy hostname is empty")
	}
	certificate, err := LoadBundled(context.Background(), hostname)
	if err != nil {
		t.Fatalf("load bundled proxy certificate: %v", err)
	}
	if err := verifyPublicTrust(certificate, hostname); err != nil {
		t.Fatalf("bundled proxy certificate is not publicly trusted: %v", err)
	}
}
