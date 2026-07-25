//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

const autostartKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const autostartValue = "RiftOps"

func getAutostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, autostartKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(autostartValue)
	return err == nil
}

func setAutostartEnabled(enabled bool) error {
	if enabled {
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("get executable path: %w", err)
		}
		abs, err := filepath.Abs(exe)
		if err != nil {
			return fmt.Errorf("resolve executable path: %w", err)
		}
		k, _, err := registry.CreateKey(registry.CURRENT_USER, autostartKey, registry.SET_VALUE)
		if err != nil {
			return fmt.Errorf("open registry key: %w", err)
		}
		defer k.Close()
		if err := k.SetStringValue(autostartValue, abs); err != nil {
			return fmt.Errorf("set registry value: %w", err)
		}
		return nil
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, autostartKey, registry.SET_VALUE)
	if err != nil {
		return nil // key doesn't exist, nothing to delete
	}
	defer k.Close()
	if err := k.DeleteValue(autostartValue); err != nil {
		return fmt.Errorf("delete registry value: %w", err)
	}
	return nil
}
