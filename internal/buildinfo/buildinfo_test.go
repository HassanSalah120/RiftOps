package buildinfo

import "testing"

func TestDefaultVersionIsDevelopmentBuild(t *testing.T) {
	if Version != DevelopmentVersion {
		t.Fatalf("default build version = %q, want %q", Version, DevelopmentVersion)
	}
}
