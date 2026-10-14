package sessionvault

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func rememberedFixture(puuid, cookie, revision string) []byte {
	claims, _ := json.Marshal(map[string]string{"sub": puuid})
	token := "e30." + base64.RawURLEncoding.EncodeToString(claims) + ".signature"
	return []byte("psl:\n  authorization:\n    riot-client:\n      id_token: " + token + "\n      refresh_token: synthetic-" + revision + "\nrso-authenticator:\n  tdid:\n    domain: riotgames.com\n    expiryTime: 2000000000\n    persistent: true\n    value: " + cookie + "\n")
}

func lifecycleVault(t *testing.T) (*Vault, string) {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "Data")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	return &Vault{RiotDataDir: dataDir, VaultDir: filepath.Join(root, "vault"), protector: testProtector{}, now: time.Now}, filepath.Join(dataDir, privateSettingsFile)
}

type replacementProtector struct {
	protector
	afterOpen func()
}

func (p replacementProtector) open(data, context []byte) ([]byte, error) {
	decoded, err := p.protector.open(data, context)
	if err == nil {
		p.afterOpen()
	}
	return decoded, err
}

func TestLoginStatusRemainsConsistentDuringSaveReplacement(t *testing.T) {
	v, path := lifecycleVault(t)
	other := Identity{PUUID: "synthetic-other", RiotID: "Other#TEST"}
	os.WriteFile(path, rememberedFixture(other.PUUID, "other-cookie", "one"), 0600)
	if err := v.Capture("account", time.Hour, other); err != nil {
		t.Fatal(err)
	}
	replacement, err := os.ReadFile(v.path("account"))
	if err != nil {
		t.Fatal(err)
	}
	defer clearBytes(replacement)
	os.WriteFile(path, rememberedFixture(testIdentity.PUUID, "first-cookie", "one"), 0600)
	if err := v.Capture("account", time.Hour, testIdentity); err != nil {
		t.Fatal(err)
	}
	replaced := false
	v.protector = replacementProtector{protector: testProtector{}, afterOpen: func() {
		if !replaced {
			replaced = true
			if err := writePrivateFile(v.path("account"), replacement); err != nil {
				t.Fatal(err)
			}
		}
	}}
	status, err := v.LoginStatus("account")
	if err != nil || status.Identity != testIdentity {
		t.Fatal("combined one save's identity with a concurrent replacement's contents")
	}
	status, err = v.LoginStatus("account")
	if err != nil || status.Identity != other {
		t.Fatal("next read did not see the completed replacement")
	}
}

func TestSettledRefreshPreservesFinalWriteAndRetention(t *testing.T) {
	v, path := lifecycleVault(t)
	os.WriteFile(path, rememberedFixture(testIdentity.PUUID, "trust-before", "one"), 0600)
	if err := v.Capture("account", 30*24*time.Hour, testIdentity); err != nil {
		t.Fatal(err)
	}
	before, _ := v.Status("account")
	final := rememberedFixture(testIdentity.PUUID, "trust-after", "two")
	os.WriteFile(path, final, 0600)
	if err := v.RefreshSettled("account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, rememberedFixture("other", "other-trust", "other"), 0600)
	if err := v.Restore("account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(final) {
		t.Fatal("restored an obsolete session")
	}
	after, _ := v.Status("account")
	if !after.ExpiresAt.Equal(before.ExpiresAt) || !after.CapturedAt.Equal(before.CapturedAt) {
		t.Fatal("extended local retention")
	}
}

func TestSettledRefreshRejectsOtherAccountAndUnknownFiles(t *testing.T) {
	for _, data := range [][]byte{rememberedFixture("other", "other-cookie", "two"), []byte("unrecognized settings")} {
		v, path := lifecycleVault(t)
		original := rememberedFixture(testIdentity.PUUID, "original", "one")
		os.WriteFile(path, original, 0600)
		if err := v.Capture("account", time.Hour, testIdentity); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(path, data, 0600)
		if err := v.RefreshSettled("account", testIdentity.RiotID); !errors.Is(err, ErrIdentityMismatch) {
			t.Fatalf("accepted unverified disk state: %v", err)
		}
		v.Restore("account", testIdentity.RiotID)
		got, _ := os.ReadFile(path)
		if string(got) != string(original) {
			t.Fatal("overwrote good saved login")
		}
	}
}

func TestFreshLoginRetainsOnlyTargetTrust(t *testing.T) {
	for _, sameAccount := range []bool{true, false} {
		v, path := lifecycleVault(t)
		os.WriteFile(path, rememberedFixture(testIdentity.PUUID, "saved-target-trust", "one"), 0600)
		if err := v.Capture("account", time.Hour, testIdentity); err != nil {
			t.Fatal(err)
		}
		livePUUID := testIdentity.PUUID
		want := "latest-target-trust"
		if !sameAccount {
			livePUUID = "other"
			want = "saved-target-trust"
		}
		os.WriteFile(path, rememberedFixture(livePUUID, "latest-target-trust", "two"), 0600)
		if err := v.PrepareFreshLogin("account", testIdentity.RiotID); err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(path)
		if !strings.Contains(string(got), want) || strings.Contains(string(got), "id_token") || strings.Contains(string(got), "refresh_token") {
			t.Fatal("fresh login lost target trust or retained authentication tokens")
		}
	}
}

func TestFreshLoginDoesNotImportTrustWithoutTargetBinding(t *testing.T) {
	v, path := lifecycleVault(t)
	os.WriteFile(path, rememberedFixture("other", "other-trust", "one"), 0600)
	if err := v.PrepareFreshLogin("new-account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("copied another account's device trust")
	}
}

func TestExpiredSavedTrustIsNotReusedOrRefreshed(t *testing.T) {
	v, path := lifecycleVault(t)
	now := time.Now()
	v.now = func() time.Time { return now }
	os.WriteFile(path, rememberedFixture(testIdentity.PUUID, "expired-save", "one"), 0600)
	v.Capture("account", time.Hour, testIdentity)
	now = now.Add(2 * time.Hour)
	if err := v.RefreshSettled("account", testIdentity.RiotID); !errors.Is(err, ErrExpired) {
		t.Fatal("revived expired save")
	}
	os.WriteFile(path, rememberedFixture("other", "other-cookie", "two"), 0600)
	if err := v.PrepareFreshLogin("account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("reused expired or wrong-account trust")
	}
}

func TestLiveCaptureRejectsAnotherAccountsDiskState(t *testing.T) {
	v, path := lifecycleVault(t)
	os.WriteFile(path, rememberedFixture("other-account", "other-trust", "one"), 0600)
	if err := v.CaptureVerified("account", time.Hour, testIdentity, func() error { return nil }); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("bound another account's disk session: %v", err)
	}
	if _, err := v.Status("account"); !errors.Is(err, ErrNotFound) {
		t.Fatal("created a mismatched save")
	}
}

func TestFreshLoginRespectsRemovalOfCurrentDeviceTrust(t *testing.T) {
	v, path := lifecycleVault(t)
	os.WriteFile(path, rememberedFixture(testIdentity.PUUID, "saved-cookie", "one"), 0600)
	if err := v.Capture("account", time.Hour, testIdentity); err != nil {
		t.Fatal(err)
	}
	live := strings.Split(string(rememberedFixture(testIdentity.PUUID, "unused", "two")), "rso-authenticator:")[0]
	os.WriteFile(path, []byte(live), 0600)
	if err := v.PrepareFreshLogin("account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("revived trust removed from the current account")
	}
}

func TestMismatchedLegacySnapshotCannotRestoreOrSupplyTrust(t *testing.T) {
	v, path := lifecycleVault(t)
	// Model an older version capturing stale account-B files while account A
	// was already authorized. The new capture path prevents creating this.
	files := map[string][]byte{"Data/" + privateSettingsFile: rememberedFixture("other", "other-cookie", "one")}
	now := time.Now()
	if err := v.storeCapture("account", testIdentity, now, now.Add(time.Hour), files); err != nil {
		t.Fatal(err)
	}
	if err := v.Restore("account", testIdentity.RiotID); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatal("restored mismatched snapshot")
	}
	if err := v.PrepareFreshLogin("account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("imported another account's trust")
	}
}

func TestTrustOnlySaveIsIncompleteAndCanBeRepairedAfterQuit(t *testing.T) {
	v, path := lifecycleVault(t)
	complete := rememberedFixture(testIdentity.PUUID, "remembered-device", "final")
	trustOnly := []byte("rso-authenticator:" + strings.Split(string(complete), "rso-authenticator:")[1])
	os.WriteFile(path, trustOnly, 0600)
	if err := v.Capture("account", time.Hour, testIdentity); err != nil {
		t.Fatal(err)
	} // simulate older capture
	before, _ := v.Status("account")
	if _, err := v.LoginStatus("account"); !errors.Is(err, ErrNotRemembered) {
		t.Fatal("reported trust-only data as reusable login")
	}
	os.WriteFile(path, complete, 0600)
	if err := v.RefreshSettled("account", testIdentity.RiotID); err != nil {
		t.Fatal(err)
	}
	after, err := v.LoginStatus("account")
	if err != nil || !after.ExpiresAt.Equal(before.ExpiresAt) {
		t.Fatal("failed to repair incomplete save within existing retention")
	}
}

func TestIncompleteLiveCaptureDoesNotOverwriteGoodSave(t *testing.T) {
	v, path := lifecycleVault(t)
	complete := rememberedFixture(testIdentity.PUUID, "good-cookie", "one")
	os.WriteFile(path, complete, 0600)
	v.Capture("account", time.Hour, testIdentity)
	incomplete := strings.Replace(string(complete), "      refresh_token: synthetic-one\n", "", 1)
	os.WriteFile(path, []byte(incomplete), 0600)
	if err := v.CaptureVerified("account", time.Hour, testIdentity, func() error { return nil }); !errors.Is(err, ErrNotRemembered) {
		t.Fatal("accepted a login without persisted refresh credentials")
	}
	v.Restore("account", testIdentity.RiotID)
	got, _ := os.ReadFile(path)
	if string(got) != string(complete) {
		t.Fatal("incomplete live state replaced good save")
	}
}

func TestForgetCannotRaceWithRefreshToRecreateSave(t *testing.T) {
	v, path := lifecycleVault(t)
	os.WriteFile(path, rememberedFixture(testIdentity.PUUID, "cookie", "one"), 0600)
	v.Capture("account", time.Hour, testIdentity)
	entered := make(chan struct{})
	release := make(chan struct{})
	refreshed := make(chan error, 1)
	deleted := make(chan error, 1)
	go func() {
		refreshed <- v.RefreshVerified("account", testIdentity, func() error { close(entered); <-release; return nil })
	}()
	<-entered
	go func() { deleted <- v.Delete("account") }()
	select {
	case <-deleted:
		close(release)
		t.Fatal("forget raced past an unfinished refresh")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-refreshed; err != nil {
		t.Fatal(err)
	}
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
	if _, err := v.Status("account"); !errors.Is(err, ErrNotFound) {
		t.Fatal("refresh recreated a forgotten save")
	}
}
