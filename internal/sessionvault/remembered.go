package sessionvault

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type rememberedState struct {
	PSL struct {
		Authorization map[string]struct {
			IDToken      string `yaml:"id_token"`
			RefreshToken string `yaml:"refresh_token"`
		} `yaml:"authorization"`
	} `yaml:"psl"`
	Auth struct {
		TDID map[string]any `yaml:"tdid,omitempty"`
	} `yaml:"rso-authenticator"`
}

func rememberedLoginReady(data []byte, expectedPUUID string) error {
	owner := diskPUUID(data)
	if owner != "" && owner != expectedPUUID {
		return ErrIdentityMismatch
	}
	var state rememberedState
	if owner == "" || yaml.Unmarshal(data, &state) != nil || state.PSL.Authorization["riot-client"].RefreshToken == "" {
		return ErrNotRemembered
	}
	return nil
}

// LoginStatus describes reusable remembered login, rather than just the
// existence/retention of an encrypted file. Older incomplete saves remain
// available for a settled, same-account refresh but cannot auto-login.
func (v *Vault) LoginStatus(profileID string) (Status, error) {
	value, err := v.load(profileID)
	if err != nil {
		return Status{}, err
	}
	defer clearBytes(value.Data)
	defer clearBytes(value.ClientData)
	defer clearFileMap(value.Files)
	status, err := v.payloadStatus(value)
	if err != nil {
		return status, err
	}
	data := value.Files["Data/"+privateSettingsFile]
	if len(data) == 0 {
		data = value.Data
	}
	return status, rememberedLoginReady(data, status.Identity.PUUID)
}

// diskPUUID is an ownership hint from Riot's own files, never proof of live
// authorization. It is compared only to an already identity-verified vault.
func diskPUUID(data []byte) string {
	var state rememberedState
	if yaml.Unmarshal(data, &state) != nil {
		return ""
	}
	token := state.PSL.Authorization["riot-client"].IDToken
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	defer clearBytes(decoded)
	var claims struct {
		Subject string `json:"sub"`
	}
	if json.Unmarshal(decoded, &claims) != nil || claims.Subject == "" || len(claims.Subject) > 128 || strings.ContainsAny(claims.Subject, "\r\n\x00") {
		return ""
	}
	return claims.Subject
}

// RefreshSettled is for a fully stopped Riot Client. Unknown or another
// account's disk files never replace the existing identity-bound save.
func (v *Vault) RefreshSettled(profileID, expectedRiotID string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	status, err := v.Status(profileID)
	if err != nil {
		return err
	}
	if !sameIdentityName(status.Identity.RiotID, expectedRiotID) {
		return ErrIdentityMismatch
	}
	files, err := v.captureFiles()
	if err != nil {
		return err
	}
	defer clearFileMap(files)
	if diskPUUID(files["Data/"+privateSettingsFile]) != status.Identity.PUUID {
		return ErrIdentityMismatch
	}
	if err := rememberedLoginReady(files["Data/"+privateSettingsFile], status.Identity.PUUID); err != nil {
		return err
	}
	return v.storeCapture(profileID, status.Identity, status.CapturedAt, status.ExpiresAt, files)
}

func sameIdentityName(a, b string) bool {
	return strings.TrimSpace(b) != "" && strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// PrepareFreshLogin removes authorization without revoking the target's
// remembered-device cookie. Prefer newer same-account disk state; otherwise
// only an unexpired, identity-bound target save may supply that cookie.
func (v *Vault) PrepareFreshLogin(profileID, expectedRiotID string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	value, err := v.load(profileID)
	var trust []byte
	liveMatches := false
	if err == nil {
		defer clearBytes(value.Data)
		defer clearBytes(value.ClientData)
		defer clearFileMap(value.Files)
		if value.Version >= 2 && sameIdentityName(value.Identity.RiotID, expectedRiotID) {
			live, readErr := readStableFile(filepath.Join(v.RiotDataDir, privateSettingsFile))
			if readErr == nil {
				defer clearBytes(live)
				if diskPUUID(live) == value.Identity.PUUID {
					liveMatches = true
					trust = v.trustOnly(live)
				}
			}
			if !liveMatches && !v.now().After(value.ExpiresAt) {
				saved := value.Files["Data/"+privateSettingsFile]
				if len(saved) == 0 {
					saved = value.Data
				}
				if diskPUUID(saved) == value.Identity.PUUID {
					trust = v.trustOnly(saved)
				}
			}
		}
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	defer clearBytes(trust)
	if err := v.clearManagedSession(); err != nil {
		return err
	}
	if len(trust) > 0 {
		return writePrivateFile(filepath.Join(v.RiotDataDir, privateSettingsFile), trust)
	}
	return nil
}

func (v *Vault) trustOnly(data []byte) []byte {
	var state rememberedState
	if yaml.Unmarshal(data, &state) != nil {
		return nil
	}
	cookie := state.Auth.TDID
	value, _ := cookie["value"].(string)
	domain, _ := cookie["domain"].(string)
	expiry, ok := cookie["expiryTime"].(int)
	if value == "" || !ok || int64(expiry) <= v.now().Unix() || !strings.EqualFold(strings.TrimPrefix(domain, "."), "riotgames.com") {
		return nil
	}
	// Serialize only this cookie, never the authentication or account sections.
	output := map[string]any{"rso-authenticator": map[string]any{"tdid": cookie}}
	encoded, err := yaml.Marshal(output)
	if err != nil || len(encoded) > maxSessionBytes {
		return nil
	}
	return encoded
}
