//go:build !windows

package riotclient

import "os/exec"

func hideCommandWindow(cmd *exec.Cmd) {}

// HideWindow is a no-op on non-Windows platforms.
func HideWindow(cmd *exec.Cmd) {}
