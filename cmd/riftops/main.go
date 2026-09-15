package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/buildinfo"
	"github.com/HassanSalah120/RiftOps/internal/certificate"
	"github.com/HassanSalah120/RiftOps/internal/diagnostics"
	"github.com/HassanSalah120/RiftOps/internal/engine"
	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/proxysetup"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

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
	validateProxyCertificate := flag.String("validate-proxy-certificate", "", "validate a PKCS#12 proxy certificate and exit")
	provisionProxyCertificate := flag.String("provision-proxy-certificate", "", "provision a trusted DuckDNS PKCS#12 proxy certificate and exit")
	proxyHostname := flag.String("proxy-hostname", "", "hostname expected by -validate-proxy-certificate")
	flag.Var(&riotArgs, "riot-arg", "extra Riot Client argument; repeatable")
	flag.Var(&gameArgs, "game-arg", "extra game argument; repeatable")
	flag.Parse()
	if *validateProxyCertificate != "" {
		if *proxyHostname == "" {
			return fmt.Errorf("-proxy-hostname is required with -validate-proxy-certificate")
		}
		return certificate.ValidatePKCS12File(*validateProxyCertificate, *proxyHostname)
	}
	if *provisionProxyCertificate != "" {
		if strings.TrimSpace(*proxyHostname) == "" {
			return fmt.Errorf("-proxy-hostname is required with -provision-proxy-certificate")
		}
		token := os.Getenv("RIFTOPS_DUCKDNS_TOKEN")
		if token == "" {
			return fmt.Errorf("RIFTOPS_DUCKDNS_TOKEN is required to provision a proxy certificate")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		_, err := proxysetup.Provision(ctx, proxysetup.ProvisionOptions{
			Hostname: *proxyHostname,
			Token:    token,
			CertPath: *provisionProxyCertificate,
		})
		return err
	}
	if *showVersion {
		fmt.Println("RiftOps", buildinfo.Version)
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
