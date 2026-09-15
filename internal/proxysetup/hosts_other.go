//go:build !windows

package proxysetup

import "errors"

func ensureLoopbackHost(string) error {
	return errors.New("automatic local hostname mapping is currently supported on Windows only")
}

func removeLoopbackHost(string) error { return nil }
