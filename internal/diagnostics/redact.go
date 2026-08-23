package diagnostics

import (
	"regexp"
)

var (
	authorizationPattern = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+`)
	entitlementPattern   = regexp.MustCompile(`(?i)(x-riot-entitlements-jwt\s*[:=]\s*)[^\s"']+`)
	tokenTagPattern      = regexp.MustCompile(`(?is)(<token(?:\s[^>]*)?>).*?(</token>)`)
	jwtPattern           = regexp.MustCompile(`\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b`)
	sensitiveKeyPattern  = regexp.MustCompile(`(?i)((?:access_?token|refresh_?token|session_?token|password|client_?secret|pair)\s*[:=]\s*["']?)[^\s&,}"']+`)
	querySecretPattern   = regexp.MustCompile(`(?i)([?&](?:access_?token|refresh_?token|session_?token|password|client_?secret|pair)=)[^&\s]+`)
	remoteCookiePattern  = regexp.MustCompile(`(?i)(riftops_remote_session=)[^;\s]+`)
	windowsPathPattern   = regexp.MustCompile(`(?i)\b[A-Z]:\\[^\s"']+`)
	homePathPattern      = regexp.MustCompile(`/(?:Users|home)/[^\s"']+`)
)

func Redact(input string) string {
	result := authorizationPattern.ReplaceAllString(input, `${1}[REDACTED]`)
	result = entitlementPattern.ReplaceAllString(result, `${1}[REDACTED]`)
	result = tokenTagPattern.ReplaceAllString(result, `${1}[REDACTED]${2}`)
	result = jwtPattern.ReplaceAllString(result, `[REDACTED_JWT]`)
	result = sensitiveKeyPattern.ReplaceAllString(result, `${1}[REDACTED]`)
	result = querySecretPattern.ReplaceAllString(result, `${1}[REDACTED]`)
	result = remoteCookiePattern.ReplaceAllString(result, `${1}[REDACTED]`)
	result = windowsPathPattern.ReplaceAllString(result, `[LOCAL_PATH]`)
	result = homePathPattern.ReplaceAllString(result, `[LOCAL_PATH]`)
	return result
}
