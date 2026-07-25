//go:build !windows && !darwin

package singleinstance

type noopLock struct{}

func Acquire(string) (Lock, error) { return noopLock{}, nil }
func (noopLock) Close() error      { return nil }
