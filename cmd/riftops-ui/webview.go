//go:build windows

package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

var (
	webviewWindow  webview2.WebView
	webviewMu      sync.RWMutex
	webviewOpening bool
)

// initializeCOM prepares the dedicated WebView goroutine as a single-threaded
// COM apartment. WebView2 must be created and pumped on this same OS thread.
func initializeCOM() (func(), error) {
	ole32 := windows.NewLazySystemDLL("ole32.dll")
	coInitializeEx := ole32.NewProc("CoInitializeEx")
	coUninitialize := ole32.NewProc("CoUninitialize")
	result, _, _ := coInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	if int32(result) < 0 {
		return func() {}, fmt.Errorf("CoInitializeEx failed: HRESULT 0x%08x", uint32(result))
	}
	return func() { coUninitialize.Call() }, nil
}

func setWebViewState(window webview2.WebView, opening bool) {
	webviewMu.Lock()
	webviewWindow = window
	webviewOpening = opening
	webviewMu.Unlock()
}

func currentWebView() (webview2.WebView, bool) {
	webviewMu.RLock()
	window, opening := webviewWindow, webviewOpening
	webviewMu.RUnlock()
	return window, opening
}

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
	webviewMu.Lock()
	if webviewOpening || webviewWindow != nil {
		webviewMu.Unlock()
		return
	}
	webviewOpening = true
	webviewMu.Unlock()

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer func() {
			if rec := recover(); rec != nil {
				setWebViewState(nil, false)
				writeReport("webview-panic", fmt.Sprintf("panic in Windows WebView host: %v", rec))
			}
		}()

		uninitializeCOM, err := initializeCOM()
		if err != nil {
			setWebViewState(nil, false)
			writeReport("webview-startup", err.Error())
			slog.Error("WebView2 COM initialization failed", "error", err)
			return
		}
		defer uninitializeCOM()

		dataPath := filepath.Join(filepath.Dir(reportDir), "webview2")
		if err := os.MkdirAll(dataPath, 0o700); err != nil {
			setWebViewState(nil, false)
			writeReport("webview-startup", fmt.Sprintf("create WebView2 data directory: %v", err))
			slog.Error("WebView2 data directory unavailable", "error", err)
			return
		}

		w := webview2.NewWithOptions(webview2.WebViewOptions{
			Debug:     false,
			AutoFocus: true,
			DataPath:  dataPath,
			WindowOptions: webview2.WindowOptions{
				Title:  "RiftOps",
				Width:  1280,
				Height: 800,
				IconId: 1, // MAINICON resource from .syso
				Center: true,
			},
		})
		if w == nil {
			setWebViewState(nil, false)
			writeReport("webview-startup", "WebView2 returned no window; the runtime may be unavailable or its profile could not be initialized")
			// WebView2 runtime unavailable — fall back to Chrome
			slog.Warn("WebView2 unavailable, falling back to Chrome app mode")
			err := launchBrowserApp(url)
			if err != nil {
				slog.Error("Failed to launch browser fallback", "error", err)
			}
			return
		}

		setWebViewState(w, false)
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
		setWebViewState(nil, false)
		slog.Info("RiftOps WebView window closed")
	}()
}

// showWebViewWindow brings the existing WebView2 window to front.
// If the window was closed, it re-creates a WebView2 window.
func showWebViewWindow() {
	window, opening := currentWebView()
	if window != nil {
		window.Dispatch(func() {
			hwnd := window.Window()
			if hwnd != nil {
				user32 := windows.NewLazySystemDLL("user32.dll")
				showWindow := user32.NewProc("ShowWindow")
				setForeground := user32.NewProc("SetForegroundWindow")
				showWindow.Call(uintptr(hwnd), 5) // SW_SHOW
				setForeground.Call(uintptr(hwnd))
			}
		})
	} else if !opening {
		// Window was closed — re-create a native WebView2 window
		safeOpenDashboard(clientURL)
	}
}

// destroyWebView destroys the WebView2 window
func destroyWebView() {
	window, _ := currentWebView()
	if window != nil {
		window.Destroy()
		time.Sleep(50 * time.Millisecond)
	}
}

// pumpUIThread asks the WebView2 message loop to run cb. It returns false
// when no window exists, in which case the watchdog skips UI probing.
func pumpUIThread(cb func()) bool {
	w, _ := currentWebView()
	if w == nil {
		return false
	}
	w.Dispatch(cb)
	return true
}
