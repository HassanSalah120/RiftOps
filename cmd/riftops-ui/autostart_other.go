//go:build !windows

package main

func getAutostartEnabled() bool {
	return false
}

func setAutostartEnabled(enabled bool) error {
	if enabled {
		return nil // silently succeed on non-Windows
	}
	return nil
}
