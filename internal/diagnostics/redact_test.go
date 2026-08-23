package diagnostics

import (
	"strings"
	"testing"
)

func TestRedact(t *testing.T) {
	secret := "abcdefghijkl.mnopqrstuvwxyz.1234567890"
	result := Redact("Authorization: Bearer secret-value Authorization: Basic cmlvdDpzZWNyZXQ= X-Riot-Entitlements-JWT=entitlement <token>" + secret + "</token> jwt=" + secret + " pair=pair-secret /?access_token=query-secret riftops_remote_session=cookie-secret C:\\Users\\person\\AppData\\Local\\riftops /Users/person/Library/RiftOps")
	for _, forbidden := range []string{"secret-value", "cmlvdDpzZWNyZXQ", "entitlement", secret, "pair-secret", "query-secret", "cookie-secret", "person"} {
		if strings.Contains(result, forbidden) {
			t.Fatalf("secret %q remained in %q", forbidden, result)
		}
	}
	if strings.Count(result, "[REDACTED]") < 6 || strings.Count(result, "[LOCAL_PATH]") != 2 {
		t.Fatalf("secret remained in %q", result)
	}
}
