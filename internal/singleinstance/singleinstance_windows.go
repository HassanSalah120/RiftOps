//go:build windows

package singleinstance

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

type fileLock struct{ handle windows.Handle }

func Acquire(path string) (Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil,
		windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_HIDDEN, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return nil, ErrAlreadyRunning
	}
	if err != nil {
		return nil, fmt.Errorf("acquire instance lock: %w", err)
	}
	return &fileLock{handle: handle}, nil
}

func (lock *fileLock) Close() error { return windows.CloseHandle(lock.handle) }
