//go:build !windows && !darwin

package main

import "log"

// macOS and Linux use the system browser for the local dashboard. Windows has
// a native WebView2 host in webview.go.
func safeOpenDashboard(url string) {
	if err := launchBrowserApp(url); err != nil {
		log.Printf("Failed to open RiftOps dashboard: %v", err)
	}
}

func showWebViewWindow() {
	safeOpenDashboard(clientURL)
}

func destroyWebView() {}

// pumpUIThread has no native window to probe outside Windows.
func pumpUIThread(func()) bool { return false }

func windowMinimize()       {}
func windowToggleMaximize() {}
func windowClose()          {}
func windowStartDrag()      {}
func windowIsMaximized() bool { return false }
