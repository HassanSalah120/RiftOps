//go:build windows

package proxysetup

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/atomicfile"
)

func windowsHostsPath() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "drivers", "etc", "hosts")
}

func ensureLoopbackHost(hostname string) error {
	path := windowsHostsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return errors.New("cannot read the Windows hosts file; run RiftOps as administrator")
	}
	text := string(data)
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) >= 2 && fields[0] == "127.0.0.1" && strings.EqualFold(fields[1], hostname) {
			return nil
		}
	}
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\r\n"
	}
	text += managedHostLine(hostname) + "\r\n"
	if err := writeHostsFile(path, []byte(text)); err != nil {
		return errors.New("cannot update the Windows hosts file; run RiftOps as administrator")
	}
	return nil
}

func removeLoopbackHost(hostname string) error {
	path := windowsHostsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return errors.New("cannot read the Windows hosts file; run RiftOps as administrator")
	}
	lines := strings.Split(string(data), "\n")
	kept := lines[:0]
	changed := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, hostsMarker) && strings.Contains(strings.ToLower(trimmed), strings.ToLower(hostname)) {
			changed = true
			continue
		}
		kept = append(kept, line)
	}
	if !changed {
		return nil
	}
	if err := writeHostsFile(path, []byte(strings.Join(kept, "\n"))); err != nil {
		return errors.New("cannot update the Windows hosts file; run RiftOps as administrator")
	}
	return nil
}

func writeHostsFile(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), "riftops-hosts-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	// Windows may hold the hosts file open briefly after DNS cache updates;
	// retrying the atomic replacement keeps the error actionable.
	for attempt := 0; attempt < 3; attempt++ {
		if err := atomicfile.Replace(name, path); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("atomic hosts-file replacement failed")
}
