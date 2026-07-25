package diagnostics

import (
	"regexp"
)

var (
	bearerPattern      = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*bearer\s+)[^\s"']+`)
	entitlementPattern = regexp.MustCompile(`(?i)(x-riot-entitlements-jwt\s*[:=]\s*)[^\s"']+`)
	tokenTagPattern    = regexp.MustCompile(`(?is)(<token(?:\s[^>]*)?>).*?(</token>)`)
	jwtPattern         = regexp.MustCompile(`\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b`)
)

func Redact(input string) string {
	result := bearerPattern.ReplaceAllString(input, `${1}[REDACTED]`)
	result = entitlementPattern.ReplaceAllString(result, `${1}[REDACTED]`)
	result = tokenTagPattern.ReplaceAllString(result, `${1}[REDACTED]${2}`)
	result = jwtPattern.ReplaceAllString(result, `[REDACTED_JWT]`)
	return result
}
