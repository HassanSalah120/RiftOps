//go:build !windows

package main

import "os/exec"

func prepareCmd(cmd *exec.Cmd) {
	// No-op on other platforms
}
