//go:build !windows && !darwin

package platform

import (
	"context"
	"fmt"
)

type unsupportedAdapter struct{}

func New() Adapter { return unsupportedAdapter{} }
func (unsupportedAdapter) DiscoverRiotClient() (string, error) {
	return "", fmt.Errorf("this operating system is not supported")
}
func (unsupportedAdapter) KnownProcesses(context.Context) ([]ProcessInfo, error) { return nil, nil }
func (unsupportedAdapter) StopKnownProcesses(context.Context) error {
	return fmt.Errorf("this operating system is not supported")
}
func (unsupportedAdapter) Launch(context.Context, LaunchRequest) (Process, error) {
	return nil, fmt.Errorf("this operating system is not supported")
}
