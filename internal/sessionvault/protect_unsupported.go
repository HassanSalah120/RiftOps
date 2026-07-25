//go:build !windows

package sessionvault

import "errors"

type platformProtector struct{}

func (platformProtector) seal(_, _ []byte) ([]byte, error) {
	return nil, errors.New("operating-system session protection is not implemented on this platform")
}

func (platformProtector) open(_, _ []byte) ([]byte, error) {
	return nil, errors.New("operating-system session protection is not implemented on this platform")
}
