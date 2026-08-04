//go:build windows

package riotclient

import (
	"os/exec"
	"syscall"
)

func hideCommandWindow(cmd *exec.Cmd) { HideWindow(cmd) }

// HideWindow sets the Windows-only flag to suppress the console window for an exec.Cmd.
func HideWindow(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
