//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

func showStartupError(title, message string) {
	const mbIconError = 0x00000010
	caption, captionErr := windows.UTF16PtrFromString(title)
	body, bodyErr := windows.UTF16PtrFromString(message)
	if captionErr != nil || bodyErr != nil {
		return
	}
	messageBox := windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(caption)), mbIconError)
}
