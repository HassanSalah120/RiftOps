package diagnostics

import (
	"strings"
	"testing"
)

func TestRedact(t *testing.T) {
	secret := "abcdefghijkl.mnopqrstuvwxyz.1234567890"
	result := Redact("Authorization: Bearer secret-value X-Riot-Entitlements-JWT=entitlement <token>" + secret + "</token> jwt=" + secret)
	if strings.Contains(result, "secret-value") || strings.Contains(result, "entitlement") || strings.Contains(result, secret) {
		t.Fatalf("secret remained in %q", result)
	}
}
