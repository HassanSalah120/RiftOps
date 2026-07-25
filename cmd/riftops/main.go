package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
	"github.com/HassanSalah120/RiftOps/internal/engine"
	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

var version = "2.3.7"

type stringList []string

func (s *stringList) String() string         { return fmt.Sprint([]string(*s)) }
func (s *stringList) Set(value string) error { *s = append(*s, value); return nil }

func main() {
	if err := run(); err != nil {
		slog.Error("RiftOps stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	var riotArgs, gameArgs stringList
	gameValue := flag.String("game", "auto", "game: auto, lol, lor, valorant, lion, riot-client")
	statusValue := flag.String("status", "", "presence: chat, offline, or mobile")
	patchline := flag.String("patchline", "live", "Riot game patchline")
	stopExisting := flag.Bool("stop-existing", false, "stop existing Riot processes before launch")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Var(&riotArgs, "riot-arg", "extra Riot Client argument; repeatable")
	flag.Var(&gameArgs, "game-arg", "extra game argument; repeatable")
	flag.Parse()
	if *showVersion {
		fmt.Println("RiftOps", version)
		return nil
	}

	game, err := model.ParseGame(*gameValue)
	if err != nil {
		return err
	}
	status := model.Status("")
	if *statusValue != "" {
		status, err = model.ParseStatus(*statusValue)
		if err != nil {
			return err
		}
	}
	settingsPath, err := settings.DefaultPath()
	if err != nil {
		return err
	}
	logger, _, err := diagnostics.OpenLogger(filepath.Join(filepath.Dir(settingsPath), "debug.log"))
	if err == nil {
		slog.SetDefault(logger)
	}
	backend, err := engine.New(settings.Store{Path: settingsPath})
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return backend.Run(ctx, engine.RunOptions{Game: game, Status: status, Patchline: *patchline,
		StopExisting: *stopExisting, RiotClientArgs: riotArgs, GameArgs: gameArgs})
}
