package proxysetup

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
)

var hostnamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,252}$`)

const hostsMarker = "# RiftOps managed chat proxy"

func validateLoopbackHostname(hostname string) error {
	hostname = strings.ToLower(strings.TrimSpace(hostname))
	if !hostnamePattern.MatchString(hostname) || strings.Contains(hostname, "..") || strings.HasSuffix(hostname, ".") {
		return errors.New("invalid local proxy hostname")
	}
	if net.ParseIP(hostname) != nil {
		return errors.New("local proxy hostname must be a DNS name")
	}
	return nil
}

// EnsureLoopbackHost adds a narrowly marked hosts-file entry. It never edits
// an unrelated user entry and requires normal OS administrator permissions.
func EnsureLoopbackHost(hostname string) error {
	if err := validateLoopbackHostname(hostname); err != nil {
		return err
	}
	return ensureLoopbackHost(hostname)
}

func RemoveLoopbackHost(hostname string) error {
	if err := validateLoopbackHostname(hostname); err != nil {
		return err
	}
	return removeLoopbackHost(hostname)
}

func managedHostLine(hostname string) string {
	return fmt.Sprintf("127.0.0.1 %s %s", hostname, hostsMarker)
}
