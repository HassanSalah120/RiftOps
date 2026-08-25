//go:build windows

package riotclient

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"

	"github.com/HassanSalah120/RiftOps/internal/platform"
)

// launchLeagueFallback follows Riot's supported product-launch flow. The Riot
// Client owns the mapping from league_of_legends to the installed game folder,
// so this works even when League is installed on another drive or outside the
// Riot Client directory. Direct League execution remains a last resort for
// older or incomplete installations.
func launchLeagueFallback(ctx context.Context) error {
	if riotExe, err := platform.New().DiscoverRiotClient(); err == nil {
		cmd := exec.CommandContext(ctx, riotExe,
			"--launch-product=league_of_legends",
			"--launch-patchline=live",
		)
		hideCommandWindow(cmd)
		if err := cmd.Start(); err == nil {
			slog.Info("lcu: launched League through Riot Client", "path", riotExe)
			return nil
		} else {
			slog.Debug("lcu: Riot Client product launch failed; using direct fallback", "error", err)
		}
	}

	exe, err := findLeagueClient()
	if err != nil {
		return fmt.Errorf("launch League: %w", err)
	}
	cmd := exec.CommandContext(ctx, exe)
	hideCommandWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch League: %w", err)
	}
	slog.Info("lcu: launched League via direct executable fallback", "path", exe)
	return nil
}
