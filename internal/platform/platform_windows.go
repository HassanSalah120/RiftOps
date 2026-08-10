//go:build windows

package platform

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type windowsAdapter struct{}

const createNoWindow = 0x08000000

func hideWindow(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func New() Adapter { return windowsAdapter{} }

func (windowsAdapter) DiscoverRiotClient() (string, error) {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	data, err := os.ReadFile(filepath.Join(programData, "Riot Games", "RiotClientInstalls.json"))
	if err != nil {
		return "", fmt.Errorf("read RiotClientInstalls.json: %w", err)
	}
	var installs map[string]any
	if err := json.Unmarshal(data, &installs); err != nil {
		return "", fmt.Errorf("decode RiotClientInstalls.json: %w", err)
	}
	for _, key := range []string{"rc_default", "rc_live", "rc_beta"} {
		path, _ := installs[key].(string)
		path = filepath.Clean(filepath.FromSlash(path))
		if executable, resolveErr := ResolveRiotClientExecutable(path); resolveErr == nil {
			return executable, nil
		}
	}
	return "", fmt.Errorf("no installed Riot Client executable was found")
}

func (windowsAdapter) KnownProcesses(ctx context.Context) ([]ProcessInfo, error) {
	cmd := exec.CommandContext(ctx, "tasklist.exe", "/FO", "CSV", "/NH")
	hideWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	rows, err := csv.NewReader(strings.NewReader(string(output))).ReadAll()
	if err != nil {
		return nil, err
	}
	known := map[string]bool{
		"riotclientservices.exe": true, "leagueclient.exe": true, "lor.exe": true,
		"valorant-win64-shipping.exe": true, "lion.exe": true,
	}
	var result []ProcessInfo
	for _, row := range rows {
		if len(row) < 2 || !known[strings.ToLower(row[0])] {
			continue
		}
		pid, err := strconv.Atoi(row[1])
		if err != nil {
			continue
		}
		result = append(result, ProcessInfo{PID: pid, Name: row[0]})
	}
	return result, nil
}

func (adapter windowsAdapter) StopKnownProcesses(ctx context.Context) error {
	processes, err := adapter.KnownProcesses(ctx)
	if err != nil {
		return err
	}
	for _, process := range processes {
		cmd := exec.CommandContext(ctx, "taskkill.exe", "/PID", strconv.Itoa(process.PID), "/T", "/F")
		hideWindow(cmd)
		output, err := cmd.CombinedOutput()
		if err != nil {
			// If the process already died between KnownProcesses and taskkill,
			// exit status 128 / "not found" is expected — skip, don't fail.
			outStr := strings.ToLower(strings.TrimSpace(string(output)))
			if strings.Contains(outStr, "not found") {
				slog.Debug("platform: process already exited", "pid", process.PID, "name", process.Name)
				continue
			}
			return fmt.Errorf("stop %s (%d): %w: %s", process.Name, process.PID, err, outStr)
		}
	}
	return nil
}

func (windowsAdapter) Launch(ctx context.Context, request LaunchRequest) (Process, error) {
	arguments, err := request.Arguments()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, request.Executable, arguments...)
	hideWindow(command)
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("launch Riot Client: %w", err)
	}
	return &commandProcess{command: command}, nil
}
