//go:build darwin

package riotclient

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// launchLeagueFallback opens the installed League app bundle. Using macOS's
// open command is important: it lets LaunchServices start the bundle exactly
// as it would from Finder, rather than trying to execute a Windows-style
// LeagueClientUx.exe path.
func launchLeagueFallback(ctx context.Context) error {
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/Applications/League of Legends.app",
		filepath.Join(home, "Applications", "League of Legends.app"),
	}
	for _, app := range candidates {
		if _, err := os.Stat(app); err != nil {
			continue
		}
		if err := exec.CommandContext(ctx, "open", app).Start(); err != nil {
			return fmt.Errorf("launch League app: %w", err)
		}
		return nil
	}

	// If League lives in a custom location but the Riot Client is installed,
	// give it the product request and let it resolve the registered install.
	cmd := exec.CommandContext(ctx, "open", "-a", "Riot Client", "--args", "--launch-product=league_of_legends", "--launch-patchline=live")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("League of Legends was not found in Applications; open Riot Client and install or launch League once: %w", err)
	}
	return nil
}
