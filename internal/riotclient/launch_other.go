//go:build !darwin

package riotclient

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
)

func launchLeagueFallback(ctx context.Context) error {
	exe, err := findLeagueClient()
	if err != nil {
		return fmt.Errorf("launch League: %w", err)
	}

	cmd := exec.CommandContext(ctx, exe)
	hideCommandWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch League: %w", err)
	}
	slog.Info("lcu: launched League via direct executable", "path", exe)
	return nil
}
