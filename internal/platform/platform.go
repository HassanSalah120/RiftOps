package platform

import (
	"context"
	"fmt"

	"github.com/HassanSalah120/RiftOps/internal/model"
)

type Process interface {
	PID() int
	Wait() error
	Kill() error
}

type Adapter interface {
	DiscoverRiotClient() (string, error)
	KnownProcesses(context.Context) ([]ProcessInfo, error)
	StopKnownProcesses(context.Context) error
	Launch(context.Context, LaunchRequest) (Process, error)
}

type ProcessInfo struct {
	PID  int
	Name string
}

type LaunchRequest struct {
	Executable     string
	ConfigURL      string
	Game           model.Game
	Patchline      string
	RiotClientArgs []string
	GameArgs       []string
}

func (r LaunchRequest) Arguments() ([]string, error) {
	if r.ConfigURL == "" {
		return nil, fmt.Errorf("config URL is required")
	}
	arguments := []string{"--client-config-url=" + r.ConfigURL}
	if product, launch := r.Game.Product(); launch {
		patchline := r.Patchline
		if patchline == "" {
			patchline = "live"
		}
		arguments = append(arguments, "--launch-product="+product, "--launch-patchline="+patchline)
	} else if r.Game != model.GameRiotClient {
		return nil, fmt.Errorf("game %q is not directly launchable", r.Game)
	}
	arguments = append(arguments, r.RiotClientArgs...)
	if len(r.GameArgs) > 0 {
		arguments = append(arguments, "--")
		arguments = append(arguments, r.GameArgs...)
	}
	return arguments, nil
}
