//go:build !windows

package riotclient

import "os/exec"

func hideCommandWindow(cmd *exec.Cmd) {}
