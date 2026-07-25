package luascript

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	lua "github.com/yuin/gopher-lua"
)

// Script represents a saved Lua script with metadata.
type Script struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Enabled  bool   `json:"enabled"`
	OnEvent  string `json:"onEvent"` // "pre-launch", "post-launch", "queue-pop", "game-end", "tick"
}

// Engine manages Lua scripting lifecycle.
type Engine struct {
	mu       sync.Mutex
	scripts  []Script
	scriptsDir string
	vm       *lua.LState
}

// RiftOpsAPI provides the Lua API that scripts can call.
type RiftOpsAPI struct {
	GetStatus     func() string
	SetStatus     func(string)
	GetGame       func() string
	SetGame       func(string)
	IsMasking     func() bool
	SetMasking    func(bool)
	AutoAccept    func(bool)
	Log           func(string)
	GetConfig     func(string) string
	SetConfig     func(string, string)
}

// NewEngine creates a Lua scripting engine.
func NewEngine(scriptsDir string, api RiftOpsAPI) (*Engine, error) {
	absDir, err := filepath.Abs(scriptsDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absDir, 0755); err != nil {
		return nil, err
	}

	e := &Engine{
		scriptsDir: absDir,
	}

	// Load existing scripts from disk
	e.loadScriptsFromDisk()

	return e, nil
}

func (e *Engine) loadScriptsFromDisk() {
	entries, err := os.ReadDir(e.scriptsDir)
	if err != nil {
		slog.Warn("luascript: cannot read scripts dir", "error", err)
		return
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	e.scripts = nil
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".lua" {
			continue
		}
		name := entry.Name()[:len(entry.Name())-4]
		code, err := os.ReadFile(filepath.Join(e.scriptsDir, entry.Name()))
		if err != nil {
			slog.Warn("luascript: cannot read script", "name", name, "error", err)
			continue
		}
		// Check for companion .enabled file
		enabled := true
		if _, err := os.Stat(filepath.Join(e.scriptsDir, name+".enabled")); err == nil {
			enabled = false
		}
		e.scripts = append(e.scripts, Script{
			Name:    name,
			Code:    string(code),
			Enabled: enabled,
			OnEvent: e.detectEvent(string(code)),
		})
	}
	slog.Debug("luascript: loaded scripts", "count", len(e.scripts))
}

func (e *Engine) detectEvent(code string) string {
	switch {
	case contains(code, "on_queue_pop"):
		return "queue-pop"
	case contains(code, "on_game_end"):
		return "game-end"
	case contains(code, "on_pre_launch"):
		return "pre-launch"
	case contains(code, "on_post_launch"):
		return "post-launch"
	case contains(code, "on_tick"):
		return "tick"
	default:
		return "manual"
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s != "" && substr != "" &&
		searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// List returns all loaded scripts.
func (e *Engine) List() []Script {
	e.mu.Lock()
	defer e.mu.Unlock()
	cp := make([]Script, len(e.scripts))
	copy(cp, e.scripts)
	return cp
}

// Save creates or updates a script on disk.
func (e *Engine) Save(name, code string, enabled bool) error {
	if name == "" {
		return fmt.Errorf("script name is required")
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	// Write the Lua file
	path := filepath.Join(e.scriptsDir, name+".lua")
	if err := os.WriteFile(path, []byte(code), 0644); err != nil {
		return err
	}

	// Write .enabled sentinel for disabled scripts
	enabledPath := filepath.Join(e.scriptsDir, name+".enabled")
	if !enabled {
		f, _ := os.Create(enabledPath)
		if f != nil {
			f.Close()
		}
	} else {
		os.Remove(enabledPath)
	}

	// Update in-memory list
	found := false
	for i, s := range e.scripts {
		if s.Name == name {
			e.scripts[i].Code = code
			e.scripts[i].Enabled = enabled
			e.scripts[i].OnEvent = e.detectEvent(code)
			found = true
			break
		}
	}
	if !found {
		e.scripts = append(e.scripts, Script{
			Name:    name,
			Code:    code,
			Enabled: enabled,
			OnEvent: e.detectEvent(code),
		})
	}

	return nil
}

// Delete removes a script from disk.
func (e *Engine) Delete(name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	os.Remove(filepath.Join(e.scriptsDir, name+".lua"))
	os.Remove(filepath.Join(e.scriptsDir, name+".enabled"))

	for i, s := range e.scripts {
		if s.Name == name {
			e.scripts = append(e.scripts[:i], e.scripts[i+1:]...)
			break
		}
	}
	return nil
}

// Toggle enables or disables a script.
func (e *Engine) Toggle(name string, enabled bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	enabledPath := filepath.Join(e.scriptsDir, name+".enabled")
	if enabled {
		os.Remove(enabledPath)
	} else {
		f, _ := os.Create(enabledPath)
		if f != nil {
			f.Close()
		}
	}

	for i, s := range e.scripts {
		if s.Name == name {
			e.scripts[i].Enabled = enabled
			break
		}
	}
	return nil
}

// Run executes a script by name.
func (e *Engine) Run(name string, api RiftOpsAPI) error {
	e.mu.Lock()
	var code string
	for _, s := range e.scripts {
		if s.Name == name {
			code = s.Code
			break
		}
	}
	e.mu.Unlock()

	if code == "" {
		return fmt.Errorf("script %q not found", name)
	}

	return e.runCode(code, api)
}

// RunEnabled executes all enabled scripts for a given event.
func (e *Engine) RunEnabled(event string, api RiftOpsAPI) {
	e.mu.Lock()
	scripts := make([]Script, len(e.scripts))
	copy(scripts, e.scripts)
	e.mu.Unlock()

	for _, s := range scripts {
		if s.Enabled && (s.OnEvent == event || s.OnEvent == "manual") {
			slog.Debug("luascript: running script", "name", s.Name, "event", event)
			if err := e.runCode(s.Code, api); err != nil {
				slog.Warn("luascript: script error", "name", s.Name, "error", err)
			}
		}
	}
}

func (e *Engine) runCode(code string, api RiftOpsAPI) error {
	vm := lua.NewState()
	defer vm.Close()

	// Register the RiftOps API as a Lua module
	registerRiftOpsAPI(vm, api)

	// Run it
	if err := vm.DoString(code); err != nil {
		return fmt.Errorf("lua error: %w", err)
	}

	return nil
}

func registerRiftOpsAPI(vm *lua.LState, api RiftOpsAPI) {
	mod := vm.NewTable()

	// riot.get_status() -> string
	vm.SetField(mod, "get_status", vm.NewFunction(func(L *lua.LState) int {
		if api.GetStatus != nil {
			L.Push(lua.LString(api.GetStatus()))
		} else {
			L.Push(lua.LString(""))
		}
		return 1
	}))

	// riot.set_status(status string)
	vm.SetField(mod, "set_status", vm.NewFunction(func(L *lua.LState) int {
		status := L.ToString(1)
		if api.SetStatus != nil {
			api.SetStatus(status)
		}
		return 0
	}))

	// riot.get_game() -> string
	vm.SetField(mod, "get_game", vm.NewFunction(func(L *lua.LState) int {
		if api.GetGame != nil {
			L.Push(lua.LString(api.GetGame()))
		} else {
			L.Push(lua.LString(""))
		}
		return 1
	}))

	// riot.set_game(game string)
	vm.SetField(mod, "set_game", vm.NewFunction(func(L *lua.LState) int {
		game := L.ToString(1)
		if api.SetGame != nil {
			api.SetGame(game)
		}
		return 0
	}))

	// riot.is_masking() -> bool
	vm.SetField(mod, "is_masking", vm.NewFunction(func(L *lua.LState) int {
		if api.IsMasking != nil {
			L.Push(lua.LBool(api.IsMasking()))
		} else {
			L.Push(lua.LFalse)
		}
		return 1
	}))

	// riot.set_masking(enabled bool)
	vm.SetField(mod, "set_masking", vm.NewFunction(func(L *lua.LState) int {
		enabled := L.ToBool(1)
		if api.SetMasking != nil {
			api.SetMasking(enabled)
		}
		return 0
	}))

	// riot.auto_accept(enabled bool)
	vm.SetField(mod, "auto_accept", vm.NewFunction(func(L *lua.LState) int {
		enabled := L.ToBool(1)
		if api.AutoAccept != nil {
			api.AutoAccept(enabled)
		}
		return 0
	}))

	// riot.log(message string)
	vm.SetField(mod, "log", vm.NewFunction(func(L *lua.LState) int {
		msg := L.ToString(1)
		if api.Log != nil {
			api.Log(msg)
		} else {
			slog.Info("lua:log", "message", msg)
		}
		return 0
	}))

	// riot.get_config(key string) -> string
	vm.SetField(mod, "get_config", vm.NewFunction(func(L *lua.LState) int {
		key := L.ToString(1)
		if api.GetConfig != nil {
			L.Push(lua.LString(api.GetConfig(key)))
		} else {
			L.Push(lua.LString(""))
		}
		return 1
	}))

	// riot.set_config(key, value string)
	vm.SetField(mod, "set_config", vm.NewFunction(func(L *lua.LState) int {
		key := L.ToString(1)
		value := L.ToString(2)
		if api.SetConfig != nil {
			api.SetConfig(key, value)
		}
		return 0
	}))

	vm.SetGlobal("riot", mod)

	// Also provide convenience shortcuts
	vm.SetGlobal("get_status", vm.NewFunction(func(L *lua.LState) int {
		if api.GetStatus != nil {
			L.Push(lua.LString(api.GetStatus()))
		} else {
			L.Push(lua.LString(""))
		}
		return 1
	}))

	// sleep(ms) - pauses execution for the given milliseconds
	vm.SetGlobal("sleep", vm.NewFunction(func(L *lua.LState) int {
		ms := L.ToInt(1)
		if ms > 0 && ms <= 30000 {
			timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
			<-timer.C
		}
		return 0
	}))
}
