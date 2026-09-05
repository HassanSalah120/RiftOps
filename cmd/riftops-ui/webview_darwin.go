//go:build darwin

package main

import "sync"

import webview "github.com/webview/webview_go"

var (
	darwinWebViewMu sync.RWMutex
	darwinWebView   webview.WebView
)

// safeOpenDashboard runs the local dashboard inside a native macOS WebKit
// window. Unlike opening Chrome, this keeps RiftOps visible as its own Dock
// application and gives the packaged .app ownership of the window.
func safeOpenDashboard(url string) {
	w := webview.New(false)
	if w == nil {
		writeReport("webview-startup", "macOS WebKit returned no native window")
		return
	}
	darwinWebViewMu.Lock()
	darwinWebView = w
	darwinWebViewMu.Unlock()
	defer func() {
		darwinWebViewMu.Lock()
		darwinWebView = nil
		darwinWebViewMu.Unlock()
		w.Destroy()
	}()
	w.SetTitle("RiftOps")
	w.SetSize(1280, 800, webview.HintNone)
	w.Navigate(url)
	w.Run()
}

// The macOS dashboard owns the application event loop, so tray reopen and
// destruction are not used on that platform.
func showWebViewWindow() {}
func destroyWebView()    {}

// pumpUIThread dispatches a heartbeat through WebKit's native event loop. The
// watchdog therefore detects a wedged macOS window independently from the
// local API probe, matching the Windows WebView2 guarantee.
func pumpUIThread(callback func()) (scheduled bool) {
	darwinWebViewMu.RLock()
	w := darwinWebView
	darwinWebViewMu.RUnlock()
	if w == nil {
		return false
	}
	defer func() {
		if recover() != nil {
			scheduled = false
		}
	}()
	w.Dispatch(callback)
	return true
}

func windowMinimize()       {}
func windowToggleMaximize() {}
func windowClose()          {}
func windowStartDrag()      {}
func windowIsMaximized() bool { return false }

