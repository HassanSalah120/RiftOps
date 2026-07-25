package singleinstance

import "errors"

var ErrAlreadyRunning = errors.New("RiftOps is already running")

type Lock interface {
	Close() error
}
