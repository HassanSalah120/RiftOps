package proxysetup

import (
	"strings"
	"testing"
)

func TestValidateOptionsRejectsNonDuckDNSAndUnsafeTokens(t *testing.T) {
	tests := []ProvisionOptions{
		{Hostname: "example.com", Token: "token", CertPath: "cert.pfx"},
		{Hostname: "riftops-hassan.duckdns.org", Token: "token with spaces", CertPath: "cert.pfx"},
		{Hostname: "riftops-hassan.duckdns.org", Token: strings.Repeat("x", maxDuckTokenLength+1), CertPath: "cert.pfx"},
		{Hostname: "riftops-hassan.duckdns.org", Token: "token", CertPath: ""},
	}
	for _, test := range tests {
		if _, err := validateOptions(test); err == nil {
			t.Fatalf("validateOptions(%+v) accepted invalid input", test)
		}
	}
}

func TestDuckDNSQueriesKeepTXTAndAddressUpdatesDistinct(t *testing.T) {
	txt := duckDNSTXTQuery("riftops-hassan.duckdns.org", "secret", "challenge", true)
	if txt.Get("domains") != "riftops-hassan" || txt.Get("txt") != "challenge" || txt.Get("clear") != "true" || txt.Has("ip") {
		t.Fatalf("unexpected TXT query: %s", txt.Encode())
	}

	address := duckDNSAddressQuery("riftops-hassan.duckdns.org", "secret", duckDNSLoopbackIP)
	if address.Get("domains") != "riftops-hassan" || address.Get("ip") != "127.0.0.1" || address.Has("txt") {
		t.Fatalf("unexpected address query: %s", address.Encode())
	}
}
func TestValidateOptionsNormalizesHostname(t *testing.T) {
	hostname, err := validateOptions(ProvisionOptions{
		Hostname: " RiftOps-Hassan.duckdns.org ", Token: "safe-token", CertPath: "cert.pfx",
	})
	if err != nil {
		t.Fatalf("validateOptions returned error: %v", err)
	}
	if hostname != "riftops-hassan.duckdns.org" {
		t.Fatalf("hostname = %q", hostname)
	}
}
