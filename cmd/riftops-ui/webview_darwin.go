//go:build darwin

package main

import webview "github.com/webview/webview_go"

// safeOpenDashboard runs the local dashboard inside a native macOS WebKit
// window. Unlike opening Chrome, this keeps RiftOps visible as its own Dock
// application and gives the packaged .app ownership of the window.
func safeOpenDashboard(url string) {
	w := webview.New(false)
	defer w.Destroy()
	w.SetTitle("RiftOps")
	w.SetSize(1280, 800, webview.HintNone)
	w.Navigate(url)
	w.Run()
}

// The macOS dashboard owns the application event loop, so tray reopen and
// destruction are not used on that platform.
func showWebViewWindow() {}
func destroyWebView()    {}
