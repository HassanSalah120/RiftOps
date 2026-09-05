package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckerAndComparison(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v1.18.0","html_url":"https://example.test/release","name":"Release","body":"Safe fixes","assets":[{"name":"RiftOps.exe"},{"name":"RiftOps.exe.sha256"}]}`))
	}))
	defer server.Close()
	release, err := (Checker{URL: server.URL}).Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	newer, err := IsNewer("1.17.2", release.Version)
	if err != nil || !newer {
		t.Fatalf("release=%+v newer=%v err=%v", release, newer, err)
	}
	if !release.ChecksumAvailable || release.Notes != "Safe fixes" || release.SignatureStatus != "not-verified-by-updater" || len(release.DownloadAssetNames) != 2 {
		t.Fatalf("release metadata was not normalized: %+v", release)
	}
}

func TestCheckerRejectsUnsafeOrOversizedReleaseResponses(t *testing.T) {
	for name, payload := range map[string]string{
		"unsafe URL": `{"tag_name":"v1.18.0","html_url":"javascript:alert(1)","name":"Release"}`,
		"oversized":  `{"tag_name":"v1.18.0","html_url":"https://example.test/release","name":"` + strings.Repeat("x", maxReleaseResponseBytes) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(payload)) }))
			defer server.Close()
			if _, err := (Checker{URL: server.URL}).Latest(context.Background()); err == nil {
				t.Fatal("unsafe release response was accepted")
			}
		})
	}
}

func TestPrereleaseVersionParses(t *testing.T) {
	newer, err := IsNewer("0.1.0-dev", "v0.1.1")
	if err != nil || !newer {
		t.Fatalf("newer=%v err=%v", newer, err)
	}
}

func TestSemanticPrereleaseOrdering(t *testing.T) {
	tests := []struct {
		current, candidate string
		newer              bool
	}{
		{"2.0.0-alpha.1", "2.0.0-alpha.2", true},
		{"2.0.0-alpha.2", "2.0.0-beta.1", true},
		{"2.0.0-rc.1", "2.0.0", true},
		{"2.0.0", "2.0.0-rc.1", false},
		{"2.0.0+build.1", "2.0.0+build.2", false},
	}
	for _, test := range tests {
		got, err := IsNewer(test.current, test.candidate)
		if err != nil || got != test.newer {
			t.Errorf("IsNewer(%q, %q) = %v, %v; want %v", test.current, test.candidate, got, err, test.newer)
		}
	}
}

func TestSameVersionIsNotNewer(t *testing.T) {
	newer, err := IsNewer("2.7.3", "v2.7.3")
	if err != nil {
		t.Fatal(err)
	}
	if newer {
		t.Fatal("the current release was reported as newer than itself")
	}
}
