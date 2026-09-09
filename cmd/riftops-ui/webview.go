//go:build windows

package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
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

// setFramelessWindow removes the native Windows title bar while keeping
// window resizing borders, minimize/maximize animations, and Windows 11 DWM shadow.
func setFramelessWindow(hwnd uintptr) {
	const (
		GWL_STYLE         = 0xFFFFFFF0 // -16
		WS_CAPTION        = 0x00C00000
		WS_THICKFRAME     = 0x00040000
		WS_MINIMIZEBOX    = 0x00020000
		WS_MAXIMIZEBOX    = 0x00010000
		WM_NCCALCSIZE     = 0x0083
		WM_NCHITTEST      = 0x0084
		HTCLIENT          = 1
		HTLEFT            = 10
		HTRIGHT           = 11
		HTTOP             = 12
		HTTOPLEFT         = 13
		HTTOPRIGHT        = 14
		HTBOTTOM          = 15
		HTBOTTOMLEFT      = 16
		HTBOTTOMRIGHT     = 17
		SM_CXSIZEFRAME    = 32
		SM_CYSIZEFRAME    = 33
		SM_CXPADDEDBORDER = 92
		SWP_FRAMECHANGED  = 0x0020
		SWP_NOMOVE        = 0x0002
		SWP_NOSIZE        = 0x0001
		SWP_NOZORDER      = 0x0004
	)

	user32 := windows.NewLazySystemDLL("user32.dll")
	getWindowLong := user32.NewProc("GetWindowLongW")
	setWindowLong := user32.NewProc("SetWindowLongW")
	getWindowLongPtr := user32.NewProc("GetWindowLongPtrW")
	setWindowLongPtr := user32.NewProc("SetWindowLongPtrW")
	setWindowPos := user32.NewProc("SetWindowPos")
	callWindowProc := user32.NewProc("CallWindowProcW")
	getWindowRect := user32.NewProc("GetWindowRect")
	getSystemMetrics := user32.NewProc("GetSystemMetrics")
	isZoomed := user32.NewProc("IsZoomed")
	wndProcIndex := ^uint(3) // GWLP_WNDPROC (-4), represented without a uintptr overflow.

	style, _, _ := getWindowLong.Call(hwnd, uintptr(GWL_STYLE))
	newStyle := (style &^ WS_CAPTION) | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
	setWindowLong.Call(hwnd, uintptr(GWL_STYLE), newStyle)

	// WS_THICKFRAME is needed for native edge resizing, but Windows otherwise
	// reserves a 7px non-client band around a captionless window. Intercept
	// WM_NCCALCSIZE so the WebView client fills the outer window while all
	// other messages continue through WebView2's original window procedure.
	// This keeps resizing and the DWM shadow without exposing a black inset.
	previousProc, _, _ := getWindowLongPtr.Call(hwnd, uintptr(wndProcIndex))
	if previousProc != 0 {
		fullClientProc := syscall.NewCallback(func(window, message, wParam, lParam uintptr) uintptr {
			if message == WM_NCCALCSIZE && wParam != 0 {
				return 0
			}
			if message == WM_NCHITTEST {
				zoomed, _, _ := isZoomed.Call(window)
				if zoomed != 0 {
					result, _, _ := callWindowProc.Call(previousProc, window, message, wParam, lParam)
					return result
				}
				// Returning a resize hit target here restores the native edge
				// affordance lost when the client area is extended over the
				// non-client frame. The title bar remains client content so its
				// JavaScript drag handler can issue HTCAPTION on mouse down.
				type rect struct{ left, top, right, bottom int32 }
				var bounds rect
				if ok, _, _ := getWindowRect.Call(window, uintptr(unsafe.Pointer(&bounds))); ok != 0 {
					x := int(int16(lParam & 0xffff))
					y := int(int16((lParam >> 16) & 0xffff))
					metricX, _, _ := getSystemMetrics.Call(SM_CXSIZEFRAME)
					metricY, _, _ := getSystemMetrics.Call(SM_CYSIZEFRAME)
					metricPadding, _, _ := getSystemMetrics.Call(SM_CXPADDEDBORDER)
					borderX := int(metricX)
					borderY := int(metricY)
					padding := int(metricPadding)
					if borderX <= 0 {
						borderX = 8
					}
					if borderY <= 0 {
						borderY = 8
					}
					borderX += padding
					borderY += padding
					left := x < int(bounds.left)+borderX
					right := x >= int(bounds.right)-borderX
					top := y < int(bounds.top)+borderY
					bottom := y >= int(bounds.bottom)-borderY
					switch {
					case left && top:
						return HTTOPLEFT
					case right && top:
						return HTTOPRIGHT
					case left && bottom:
						return HTBOTTOMLEFT
					case right && bottom:
						return HTBOTTOMRIGHT
					case left:
						return HTLEFT
					case right:
						return HTRIGHT
					case top:
						return HTTOP
					case bottom:
						return HTBOTTOM
					default:
						return HTCLIENT
					}
				}
			}
			result, _, _ := callWindowProc.Call(previousProc, window, message, wParam, lParam)
			return result
		})
		setWindowLongPtr.Call(hwnd, uintptr(wndProcIndex), fullClientProc)
	}

	// Extend the DWM frame across the whole client area. With a custom HTML
	// title bar, the default 1px frame leaves the WS_THICKFRAME non-client
	// inset visible as a dark strip above and beside the app (7px on Windows
	// 11 at the default DPI). The resize style remains enabled, so the native
	// hit-testing/shadow behavior is preserved while the WebView fills the
	// window edge-to-edge.
	dwmapi := windows.NewLazySystemDLL("dwmapi.dll")
	dwmExtend := dwmapi.NewProc("DwmExtendFrameIntoClientArea")
	type MARGINS struct {
		CxLeftWidth, CxRightWidth, CyTopHeight, CyBottomHeight int32
	}
	margins := MARGINS{-1, -1, -1, -1}
	dwmExtend.Call(hwnd, uintptr(unsafe.Pointer(&margins)))

	setWindowPos.Call(
		hwnd,
		0,
		0, 0, 0, 0,
		SWP_FRAMECHANGED|SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER,
	)
}

func windowMinimize() {
	window, _ := currentWebView()
	if window != nil {
		window.Dispatch(func() {
			hwnd := window.Window()
			if hwnd != nil {
				user32 := windows.NewLazySystemDLL("user32.dll")
				showWindow := user32.NewProc("ShowWindow")
				showWindow.Call(uintptr(hwnd), 6) // SW_MINIMIZE
			}
		})
	}
}

func windowToggleMaximize() {
	window, _ := currentWebView()
	if window != nil {
		window.Dispatch(func() {
			hwnd := window.Window()
			if hwnd != nil {
				user32 := windows.NewLazySystemDLL("user32.dll")
				isZoomed := user32.NewProc("IsZoomed")
				showWindow := user32.NewProc("ShowWindow")
				res, _, _ := isZoomed.Call(uintptr(hwnd))
				if res != 0 {
					showWindow.Call(uintptr(hwnd), 9) // SW_RESTORE
				} else {
					showWindow.Call(uintptr(hwnd), 3) // SW_MAXIMIZE
				}
			}
		})
	}
}

func windowClose() {
	window, _ := currentWebView()
	if window != nil {
		window.Dispatch(func() {
			hwnd := window.Window()
			if hwnd != nil {
				user32 := windows.NewLazySystemDLL("user32.dll")
				showWindow := user32.NewProc("ShowWindow")
				showWindow.Call(uintptr(hwnd), 0) // SW_HIDE (clean minimize to tray)
			}
		})
	}
}

func windowStartDrag() {
	window, _ := currentWebView()
	if window != nil {
		window.Dispatch(func() {
			hwnd := window.Window()
			if hwnd != nil {
				user32 := windows.NewLazySystemDLL("user32.dll")
				releaseCapture := user32.NewProc("ReleaseCapture")
				sendMessage := user32.NewProc("SendMessageW")
				releaseCapture.Call()
				sendMessage.Call(uintptr(hwnd), 0x00A1 /* WM_NCLBUTTONDOWN */, 2 /* HTCAPTION */, 0)
			}
		})
	}
}

func windowIsMaximized() bool {
	window, _ := currentWebView()
	if window != nil {
		hwnd := window.Window()
		if hwnd != nil {
			user32 := windows.NewLazySystemDLL("user32.dll")
			isZoomed := user32.NewProc("IsZoomed")
			res, _, _ := isZoomed.Call(uintptr(hwnd))
			return res != 0
		}
	}
	return false
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

// setWindowIcons sets both the large (taskbar/Alt-Tab) and small (titlebar) icons on the window.
func setWindowIcons(hwnd uintptr) {
	const (
		WM_SETICON  = 0x0080
		ICON_SMALL  = 0
		ICON_BIG    = 1
		IMAGE_ICON  = 1
		LR_SHARED   = 0x00008000
		SM_CXICON   = 11
		SM_CYICON   = 12
		SM_CXSMICON = 49
		SM_CYSMICON = 50
	)

	user32 := windows.NewLazySystemDLL("user32.dll")
	sendMessage := user32.NewProc("SendMessageW")
	loadImage := user32.NewProc("LoadImageW")
	getSystemMetrics := user32.NewProc("GetSystemMetrics")

	var hinstance windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinstance)

	cxSm, _, _ := getSystemMetrics.Call(SM_CXSMICON)
	cySm, _, _ := getSystemMetrics.Call(SM_CYSMICON)
	cxLg, _, _ := getSystemMetrics.Call(SM_CXICON)
	cyLg, _, _ := getSystemMetrics.Call(SM_CYICON)

	// Resource ID 1 is MAINICON / RT_GROUP_ICON in rsrc_windows_amd64.syso
	hSmall, _, _ := loadImage.Call(uintptr(hinstance), 1, IMAGE_ICON, cxSm, cySm, LR_SHARED)
	if hSmall != 0 {
		sendMessage.Call(hwnd, WM_SETICON, ICON_SMALL, hSmall)
	}

	hBig, _, _ := loadImage.Call(uintptr(hinstance), 1, IMAGE_ICON, cxLg, cyLg, LR_SHARED)
	if hBig != 0 {
		sendMessage.Call(hwnd, WM_SETICON, ICON_BIG, hBig)
	}
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

		w.Bind("riftopsMinimizeWindow", func() {
			windowMinimize()
		})
		w.Bind("riftopsMaximizeWindow", func() {
			windowToggleMaximize()
		})
		w.Bind("riftopsCloseWindow", func() {
			windowClose()
		})
		w.Bind("riftopsStartWindowDrag", func() {
			windowStartDrag()
		})
		w.Bind("riftopsIsWindowMaximized", func() bool {
			return windowIsMaximized()
		})

		setWebViewState(w, false)
		w.Navigate(url)

		// Set frameless window, dark title bar and native window icons after window is ready
		w.Dispatch(func() {
			hwnd := w.Window()
			if hwnd != nil {
				setFramelessWindow(uintptr(hwnd))
				setDarkTitleBar(uintptr(hwnd))
				setWindowIcons(uintptr(hwnd))
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
				isIconic := user32.NewProc("IsIconic")
				isMin, _, _ := isIconic.Call(uintptr(hwnd))
				if isMin != 0 {
					showWindow.Call(uintptr(hwnd), 9) // SW_RESTORE
				} else {
					showWindow.Call(uintptr(hwnd), 5) // SW_SHOW
				}
				setForeground.Call(uintptr(hwnd))
				setWindowIcons(uintptr(hwnd))
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
