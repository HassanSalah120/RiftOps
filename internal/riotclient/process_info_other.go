//go:build !windows

package riotclient

import (
	"os/exec"
	"strconv"
	"strings"
)

// LeagueProcessInfo holds uptime and memory usage for LeagueClientUx.exe.
type LeagueProcessInfo struct {
	UptimeSec  int64   `json:"uptime"`
	MemoryMB   int64   `json:"memoryMB"`
	CPUPercent float64 `json:"cpuPercent"`
}

// GetLeagueProcessInfo uses ps on macOS/Linux so the client health card also
// reports useful resource data outside Windows.
func GetLeagueProcessInfo() LeagueProcessInfo {
	var info LeagueProcessInfo
	out, err := exec.Command("ps", "-axo", "comm=,etime=,rss=,%cpu=").Output()
	if err != nil {
		return info
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || !strings.Contains(strings.ToLower(fields[0]), "leagueclient") {
			continue
		}
		if rss, parseErr := strconv.ParseInt(fields[len(fields)-2], 10, 64); parseErr == nil {
			info.MemoryMB += rss / 1024
		}
		if cpu, parseErr := strconv.ParseFloat(fields[len(fields)-1], 64); parseErr == nil {
			info.CPUPercent += cpu
		}
		if elapsed := parseProcessElapsed(fields[1]); elapsed > info.UptimeSec {
			info.UptimeSec = elapsed
		}
	}
	return info
}

func parseProcessElapsed(value string) int64 {
	parts := strings.Split(value, "-")
	days := int64(0)
	clock := parts[len(parts)-1]
	if len(parts) == 2 {
		days, _ = strconv.ParseInt(parts[0], 10, 64)
	}
	fields := strings.Split(clock, ":")
	var seconds int64
	for _, field := range fields {
		value, err := strconv.ParseInt(field, 10, 64)
		if err != nil {
			return 0
		}
		seconds = seconds*60 + value
	}
	return days*24*60*60 + seconds
}
