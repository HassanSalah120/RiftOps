//go:build darwin

package platform

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type darwinAdapter struct{}

func New() Adapter { return darwinAdapter{} }

func (darwinAdapter) DiscoverRiotClient() (string, error) {
	home, _ := os.UserHomeDir()
	roots := []string{
		"/Applications/League of Legends.app",
		"/Applications/Riot Client.app",
		filepath.Join(home, "Applications", "League of Legends.app"),
		filepath.Join(home, "Applications", "Riot Client.app"),
	}
	for _, root := range roots {
		if _, err := os.Stat(root); err != nil {
			continue
		}
		var found string
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || found != "" {
				return fs.SkipAll
			}
			if entry.IsDir() {
				return nil
			}
			name := strings.ToLower(entry.Name())
			if name != "riotclientservices" && name != "riot client" {
				return nil
			}
			info, infoErr := entry.Info()
			if infoErr == nil && info.Mode()&0o111 != 0 {
				found = path
				return fs.SkipAll
			}
			return nil
		})
		if found != "" {
			return found, nil
		}
	}
	return "", fmt.Errorf("no Riot Client executable found inside an installed app bundle")
}

func (darwinAdapter) KnownProcesses(ctx context.Context) ([]ProcessInfo, error) {
	output, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,comm=").Output()
	if err != nil {
		return nil, err
	}
	known := []string{"riotclientservices", "leagueclient", "league of legends"}
	var result []ProcessInfo
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		name := strings.ToLower(strings.Join(fields[1:], " "))
		for _, candidate := range known {
			if strings.Contains(name, candidate) {
				result = append(result, ProcessInfo{PID: pid, Name: name})
				break
			}
		}
	}
	return result, nil
}

func (adapter darwinAdapter) StopKnownProcesses(ctx context.Context) error {
	processes, err := adapter.KnownProcesses(ctx)
	if err != nil {
		return err
	}
	for _, process := range processes {
		if err := exec.CommandContext(ctx, "kill", "-TERM", strconv.Itoa(process.PID)).Run(); err != nil {
			return fmt.Errorf("stop %s (%d): %w", process.Name, process.PID, err)
		}
	}
	return nil
}

func (darwinAdapter) Launch(ctx context.Context, request LaunchRequest) (Process, error) {
	arguments, err := request.Arguments()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, request.Executable, arguments...)
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("launch Riot Client: %w", err)
	}
	return &commandProcess{command: command}, nil
}
