package platform

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/HassanSalah120/RiftOps/internal/model"
)

var riotExecutableNames = map[string]struct{}{
	"riotclientservices":     {},
	"riotclientservices.exe": {},
	"riot client":            {},
	"leagueclient":           {},
	"leagueclient.exe":       {},
}

// ResolveRiotClientExecutable accepts either an executable or an installed
// Riot/League application directory and returns the launchable client binary.
func ResolveRiotClientExecutable(candidate string) (string, error) {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return "", fmt.Errorf("Riot Client location is empty")
	}
	absolute, err := filepath.Abs(filepath.Clean(candidate))
	if err != nil {
		return "", fmt.Errorf("resolve Riot Client location: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("Riot Client location does not exist: %w", err)
	}
	if !info.IsDir() {
		return validateRiotExecutable(absolute, info)
	}

	preferred := []string{
		filepath.Join("Contents", "LoL", "RiotClientServices.app", "Contents", "MacOS", "RiotClientServices"),
		filepath.Join("Contents", "RiotClientServices.app", "Contents", "MacOS", "RiotClientServices"),
		filepath.Join("Contents", "LoL", "LeagueClient.app", "Contents", "MacOS", "LeagueClient"),
		filepath.Join("Contents", "MacOS", "RiotClientServices"),
		filepath.Join("Contents", "MacOS", "Riot Client"),
		filepath.Join("Contents", "MacOS", "LeagueClient"),
		"RiotClientServices.exe",
		"LeagueClient.exe",
	}
	for _, relative := range preferred {
		path := filepath.Join(absolute, relative)
		if candidateInfo, statErr := os.Stat(path); statErr == nil && !candidateInfo.IsDir() {
			if resolved, validateErr := validateRiotExecutable(path, candidateInfo); validateErr == nil {
				return resolved, nil
			}
		}
	}

	var found string
	_ = filepath.WalkDir(absolute, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if found != "" {
			return fs.SkipAll
		}
		if entry.IsDir() {
			return nil
		}
		if _, known := riotExecutableNames[strings.ToLower(entry.Name())]; !known {
			return nil
		}
		entryInfo, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if resolved, validateErr := validateRiotExecutable(path, entryInfo); validateErr == nil {
			found = resolved
			return fs.SkipAll
		}
		return nil
	})
	if found == "" {
		return "", fmt.Errorf("no RiotClientServices or LeagueClient executable was found inside %s", absolute)
	}
	return found, nil
}

func validateRiotExecutable(path string, info os.FileInfo) (string, error) {
	if _, known := riotExecutableNames[strings.ToLower(filepath.Base(path))]; !known {
		return "", fmt.Errorf("%s is not a RiotClientServices or LeagueClient executable", path)
	}
	if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
		return "", fmt.Errorf("%s is not executable", path)
	}
	return filepath.Clean(path), nil
}

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
