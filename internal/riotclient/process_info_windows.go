//go:build windows

package riotclient

import (
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// LeagueProcessInfo holds uptime and memory usage for LeagueClientUx.exe.
type LeagueProcessInfo struct {
	UptimeSec  int64   `json:"uptime"`
	MemoryMB   int64   `json:"memoryMB"`
	CPUPercent float64 `json:"cpuPercent"`
}

type processMemoryCounters struct {
	Size                    uint32
	PageFaultCount          uint32
	PeakWorkingSetSize      uintptr
	WorkingSetSize          uintptr
	QuotaPeakPagedPoolUsage uintptr
	QuotaPagedPoolUsage     uintptr
	QuotaPeakNonPagedUsage  uintptr
	QuotaNonPagedUsage      uintptr
	PagefileUsage           uintptr
	PeakPagefileUsage       uintptr
}

var (
	processMetricsMu       sync.Mutex
	processMetricsAt       time.Time
	processMetricsCached   LeagueProcessInfo
	previousProcessCPU     = make(map[uint32]uint64)
	previousProcessCPUAt   time.Time
	previousProcessPercent float64
	psapi                  = windows.NewLazySystemDLL("psapi.dll")
	getProcessMemoryInfo   = psapi.NewProc("GetProcessMemoryInfo")
)

// GetLeagueProcessInfo uses native Windows process APIs. The former
// implementation launched two PowerShell processes plus cmd/tasklist for every
// health refresh, which caused console flashes and could stall the WebView.
func GetLeagueProcessInfo() LeagueProcessInfo {
	processMetricsMu.Lock()
	defer processMetricsMu.Unlock()

	now := time.Now()
	if !processMetricsAt.IsZero() && now.Sub(processMetricsAt) < 2*time.Second {
		return processMetricsCached
	}

	info, cpuSamples := readLeagueProcessMetrics(now)
	if !previousProcessCPUAt.IsZero() {
		elapsed := now.Sub(previousProcessCPUAt)
		var used100ns uint64
		for pid, current := range cpuSamples {
			if previous, ok := previousProcessCPU[pid]; ok && current >= previous {
				used100ns += current - previous
			}
		}
		if elapsed > 0 {
			cores := runtime.NumCPU()
			if cores < 1 {
				cores = 1
			}
			cpu := (float64(used100ns) * 100) / float64(elapsed.Nanoseconds()) / float64(cores) * 100
			if cpu >= 0 && cpu <= 100 {
				previousProcessPercent = cpu
			}
		}
	}
	info.CPUPercent = previousProcessPercent
	if len(cpuSamples) == 0 {
		info.CPUPercent = 0
		previousProcessPercent = 0
	}

	previousProcessCPU = cpuSamples
	previousProcessCPUAt = now
	processMetricsCached = info
	processMetricsAt = now
	return info
}

func readLeagueProcessMetrics(now time.Time) (LeagueProcessInfo, map[uint32]uint64) {
	var info LeagueProcessInfo
	cpuSamples := make(map[uint32]uint64)
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return info, cpuSamples
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return info, cpuSamples
	}
	earliest := now
	found := false
	for {
		name := strings.ToLower(windows.UTF16ToString(entry.ExeFile[:]))
		if name == "leagueclientux.exe" || strings.HasPrefix(name, "leagueclientuxrender.exe") {
			found = true
			readOneProcess(entry.ProcessID, &info, cpuSamples, &earliest)
		}
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			break
		}
	}
	if found && earliest.Before(now) {
		info.UptimeSec = int64(now.Sub(earliest).Seconds())
	}
	return info, cpuSamples
}

func readOneProcess(pid uint32, info *LeagueProcessInfo, cpuSamples map[uint32]uint64, earliest *time.Time) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ, false, pid)
	if err != nil {
		return
	}
	defer windows.CloseHandle(handle)

	var creation, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user) == nil {
		createdAt := time.Unix(0, creation.Nanoseconds())
		if createdAt.Before(*earliest) {
			*earliest = createdAt
		}
		cpuSamples[pid] = rawFiletime(kernel) + rawFiletime(user)
	}

	counters := processMemoryCounters{Size: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	result, _, _ := getProcessMemoryInfo.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.Size),
	)
	if result != 0 {
		info.MemoryMB += int64(counters.WorkingSetSize / (1024 * 1024))
	}
}

func rawFiletime(value windows.Filetime) uint64 {
	return uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime)
}
