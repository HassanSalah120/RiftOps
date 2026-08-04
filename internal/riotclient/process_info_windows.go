//go:build windows

package riotclient

import (
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// LeagueProcessInfo holds uptime and memory usage for LeagueClientUx.exe.
type LeagueProcessInfo struct {
	UptimeSec int64 `json:"uptime"`
	MemoryMB  int64 `json:"memoryMB"`
}

// GetLeagueProcessInfo queries Windows for LeagueClientUx uptime and memory.
// Uses hidden PowerShell/cmd windows so no console flashes appear.
func GetLeagueProcessInfo() LeagueProcessInfo {
	var info LeagueProcessInfo

	// Uptime via PowerShell WMI query
	psCmd := `Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress`
	ps := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	hideCommandWindow(ps)
	if out, psErr := ps.Output(); psErr == nil && len(out) > 2 {
		var proc struct {
			PID          int64  `json:"ProcessId"`
			CreationDate string `json:"CreationDate"`
		}
		if json.Unmarshal(out, &proc) == nil && proc.CreationDate != "" {
			if t, tErr := time.Parse("20060102150405.000000-0700", proc.CreationDate); tErr == nil {
				info.UptimeSec = int64(time.Since(t).Seconds())
			}
		}
	}

	// Memory via tasklist CSV
	tlCmd := `tasklist /FI "IMAGENAME eq LeagueClientUx.exe" /FO CSV /NH`
	tl := exec.Command("cmd.exe", "/C", tlCmd)
	hideCommandWindow(tl)
	if out, tlErr := tl.Output(); tlErr == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(strings.ToLower(line), "leagueclientux") {
				parts := strings.Split(line, ",")
				if len(parts) >= 5 {
					memStr := strings.Trim(parts[4], "\" K")
					memStr = strings.ReplaceAll(memStr, ",", "")
					if kb, kbErr := strconv.ParseInt(memStr, 10, 64); kbErr == nil {
						info.MemoryMB = kb / 1024
					}
				}
				break
			}
		}
	}

	return info
}
