//go:build windows

package main

import (
	"log"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

var webviewWindow webview2.WebView

// setDarkTitleBar enables the dark immersive title bar via DWM.
// Must be called from the UI thread (inside w.Dispatch()).
func setDarkTitleBar(hwnd uintptr) {
	// DWMWA_USE_IMMERSIVE_DARK_MODE = 20
	const DWMWA_USE_IMMERSIVE_DARK_MODE = 20

	dwmapi := windows.NewLazySystemDLL("dwmapi.dll")
	dwmset := dwmapi.NewProc("DwmSetWindowAttribute")

	dark := uint32(1) // TRUE = dark title bar
	dwmset.Call(
		hwnd,
		DWMWA_USE_IMMERSIVE_DARK_MODE,
		uintptr(unsafe.Pointer(&dark)),
		4, // sizeof(uint32)
	)
}

// safeOpenDashboard tries WebView2 first, falls back to Chrome --app=
func safeOpenDashboard(url string) {
	go func() {
		w := webview2.NewWithOptions(webview2.WebViewOptions{
			Debug:     false,
			AutoFocus: true,
			WindowOptions: webview2.WindowOptions{
				Title:  "RiftOps",
				Width:  1280,
				Height: 800,
				IconId: 1, // MAINICON resource from .syso
				Center: true,
			},
		})
		if w == nil {
			// WebView2 runtime unavailable — fall back to Chrome
			log.Println("WebView2 unavailable, falling back to Chrome --app=")
			err := launchBrowserApp(url)
			if err != nil {
				log.Printf("Failed to launch browser: %v", err)
			}
			return
		}

		webviewWindow = w
		w.Navigate(url)

		// Set dark title bar after window is ready
		w.Dispatch(func() {
			hwnd := w.Window()
			if hwnd != nil {
				setDarkTitleBar(uintptr(hwnd))
			}
		})

		w.Run()
		// Run() returns when the window is closed or Terminate() called
		webviewWindow = nil
	}()
}

// showWebViewWindow brings the existing WebView2 window to front.
// If the window was closed, it re-creates a WebView2 window.
func showWebViewWindow() {
	if webviewWindow != nil {
		webviewWindow.Dispatch(func() {
			hwnd := webviewWindow.Window()
			if hwnd != nil {
				user32 := windows.NewLazySystemDLL("user32.dll")
				showWindow := user32.NewProc("ShowWindow")
				setForeground := user32.NewProc("SetForegroundWindow")
				showWindow.Call(uintptr(hwnd), 5) // SW_SHOW
				setForeground.Call(uintptr(hwnd))
			}
		})
	} else {
		// Window was closed — re-create a native WebView2 window
		safeOpenDashboard(clientURL)
	}
}

// destroyWebView destroys the WebView2 window
func destroyWebView() {
	if webviewWindow != nil {
		webviewWindow.Destroy()
		time.Sleep(50 * time.Millisecond)
	}
}
