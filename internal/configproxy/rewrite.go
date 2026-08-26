package configproxy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type Endpoint struct {
	Host string
	Port int
}

func (endpoint Endpoint) Valid() bool {
	return endpoint.Host != "" && endpoint.Port > 0 && endpoint.Port <= 65535
}

type RewriteOptions struct {
	LocalHost string
	LocalPort int
	Affinity  string
}

func Rewrite(content []byte, options RewriteOptions) ([]byte, Endpoint, error) {
	if options.LocalHost == "" || options.LocalPort <= 0 || options.LocalPort > 65535 {
		return nil, Endpoint{}, fmt.Errorf("invalid local proxy endpoint %q:%d", options.LocalHost, options.LocalPort)
	}
	var config map[string]any
	if err := json.Unmarshal(content, &config); err != nil {
		return nil, Endpoint{}, fmt.Errorf("decode client config: %w", err)
	}
	endpoint := Endpoint{}
	if host, ok := config["chat.host"].(string); ok {
		endpoint.Host = host
	}
	if port, ok := jsonNumberToInt(config["chat.port"]); ok {
		endpoint.Port = port
	}
	if affinities, ok := config["chat.affinities"].(map[string]any); ok {
		// Recent client-config responses may omit chat.host and publish only
		// the affinity map. Prefer the player's affinity when available, then
		// use a deterministic non-empty entry as the fallback chat server.
		if host, ok := affinityHost(affinities, options.Affinity); ok {
			endpoint.Host = host
		}
	}
	if !endpoint.Valid() {
		return append([]byte(nil), content...), Endpoint{}, nil
	}
	config["chat.host"] = options.LocalHost
	config["chat.port"] = options.LocalPort
	if affinities, ok := config["chat.affinities"].(map[string]any); ok {
		for key := range affinities {
			affinities[key] = options.LocalHost
		}
	}
	modified, err := json.Marshal(config)
	if err != nil {
		return nil, Endpoint{}, fmt.Errorf("encode client config: %w", err)
	}
	return modified, endpoint, nil
}

func affinityHost(affinities map[string]any, preferred string) (string, bool) {
	if preferred != "" {
		if host, ok := affinities[preferred].(string); ok && strings.TrimSpace(host) != "" {
			return strings.TrimSpace(host), true
		}
	}
	keys := make([]string, 0, len(affinities))
	for key := range affinities {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if host, ok := affinities[key].(string); ok && strings.TrimSpace(host) != "" {
			return strings.TrimSpace(host), true
		}
	}
	return "", false
}

func AffinityFromJWT(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return "", fmt.Errorf("token has %d segments", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("decode token payload: %w", err)
	}
	var claims struct {
		Affinity string `json:"affinity"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", fmt.Errorf("decode token claims: %w", err)
	}
	if claims.Affinity == "" {
		return "", fmt.Errorf("token contains no affinity")
	}
	return claims.Affinity, nil
}

func jsonNumberToInt(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		if number <= 0 || number > 65535 || number != float64(int(number)) {
			return 0, false
		}
		return int(number), true
	case json.Number:
		parsed, err := number.Int64()
		return int(parsed), err == nil && parsed > 0 && parsed <= 65535
	default:
		return 0, false
	}
}
