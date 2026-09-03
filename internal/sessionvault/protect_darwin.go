//go:build darwin

package sessionvault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"sync"
)

const macKeychainService = "com.hassansalah120.riftops.sessionvault"

var macKeychainMu sync.Mutex

// platformProtector stores the vault key in the user's macOS Keychain and
// encrypts each profile blob with AES-GCM. The profile ID is additional
// authenticated data, so a vault file cannot be moved to another profile and
// still decrypt successfully.
type platformProtector struct{}

func (platformProtector) seal(plaintext, context []byte) ([]byte, error) {
	key, err := macKeychainKey()
	if err != nil {
		return nil, err
	}
	return encryptSession(key, plaintext, context)
}

func (platformProtector) open(ciphertext, context []byte) ([]byte, error) {
	key, err := macKeychainKey()
	if err != nil {
		return nil, err
	}
	return decryptSession(key, ciphertext, context)
}

func encryptSession(key, plaintext, context []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(nonce, gcm.Seal(nil, nonce, plaintext, context)...), nil
}

func decryptSession(key, ciphertext, context []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("saved Riot login payload was too short")
	}
	nonce, sealed := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	return gcm.Open(nil, nonce, sealed, context)
}

func macKeychainKey() ([]byte, error) {
	macKeychainMu.Lock()
	defer macKeychainMu.Unlock()

	account := macKeychainAccount()
	find := exec.Command("security", "find-generic-password", "-a", account, "-s", macKeychainService, "-w")
	value, err := find.Output()
	if err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(value)))
		if decodeErr != nil || len(key) != 32 {
			return nil, errors.New("RiftOps macOS Keychain session key is invalid")
		}
		return key, nil
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	add := exec.Command("security", "add-generic-password", "-a", account, "-s", macKeychainService, "-w", encoded, "-U")
	if err := add.Run(); err != nil {
		for i := range key {
			key[i] = 0
		}
		return nil, fmt.Errorf("store Riot login key in macOS Keychain: %w", err)
	}
	return key, nil
}

func macKeychainAccount() string {
	if value := strings.TrimSpace(os.Getenv("USER")); value != "" {
		return value
	}
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.Username) != "" {
		return current.Username
	}
	return "riftops"
}
