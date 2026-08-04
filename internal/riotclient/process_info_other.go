//go:build !windows

package riotclient

// LeagueProcessInfo holds uptime and memory usage for LeagueClientUx.exe.
type LeagueProcessInfo struct {
	UptimeSec int64 `json:"uptime"`
	MemoryMB  int64 `json:"memoryMB"`
}

// GetLeagueProcessInfo is a no-op on non-Windows platforms.
func GetLeagueProcessInfo() LeagueProcessInfo {
	return LeagueProcessInfo{}
}
