package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestDashboardPortMarkerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := writeDashboardPort(dir, 24083); err != nil {
		t.Fatalf("writeDashboardPort() error = %v", err)
	}
	if got := readDashboardPort(dir); got != 24083 {
		t.Fatalf("readDashboardPort() = %d, want 24083", got)
	}
}

func TestListenDashboardFallsBackWhenPreferredPortIsBusy(t *testing.T) {
	blocker, err := net.Listen("tcp4", "127.0.0.1:24080")
	if err != nil {
		t.Skipf("preferred dashboard port is already occupied: %v", err)
	}
	defer blocker.Close()

	listener, selectedPort, err := listenDashboard()
	if err != nil {
		t.Fatalf("listenDashboard() error = %v", err)
	}
	defer listener.Close()
	if selectedPort == preferredPort {
		t.Fatalf("listenDashboard() selected busy preferred port %d", selectedPort)
	}
}

func TestDashboardPortMarkerFallsBackForInvalidData(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, portFileName), []byte("not-a-port"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readDashboardPort(dir); got != preferredPort {
		t.Fatalf("readDashboardPort() = %d, want preferred port %d", got, preferredPort)
	}
}
