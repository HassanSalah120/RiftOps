package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/platform"
	"github.com/HassanSalah120/RiftOps/internal/sessionvault"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

func (e *Engine) closeCancelledClient(adapter platform.Adapter) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := e.closeRiot(ctx, adapter); err != nil {
		slog.Warn("could not close Riot after runtime cancellation", "error", err)
	}
}

// closeRiot lets Riot flush its state before any forced process termination.
// A rejected/unavailable quit endpoint keeps the existing force-close fallback.
func (e *Engine) closeRiot(ctx context.Context, adapter platform.Adapter) error {
	processes, err := adapter.KnownProcesses(ctx)
	if err != nil {
		return fmt.Errorf("%w: inspect client", ErrRiotCloseFailed)
	}
	if len(processes) == 0 {
		return nil
	}
	quitCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	quitErr := e.requestRiotQuit(quitCtx)
	cancel()
	if quitErr == nil {
		waitCtx, stop := context.WithTimeout(ctx, 8*time.Second)
		err = waitForNoRiotProcesses(waitCtx, adapter)
		stop()
		if err == nil {
			return nil
		}
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrRiotCloseFailed, err)
	}
	if err := adapter.StopKnownProcesses(ctx); err != nil {
		processes, inspectErr := adapter.KnownProcesses(ctx)
		if inspectErr != nil || len(processes) > 0 {
			return ErrRiotCloseFailed
		}
	}
	if err := waitForNoRiotProcesses(ctx, adapter); err != nil {
		return fmt.Errorf("%w: %v", ErrRiotCloseFailed, err)
	}
	return nil
}

func (e *Engine) refreshStoppedProfile(ctx context.Context, adapter platform.Adapter, profile settings.LaunchProfile) error {
	if e.vault == nil {
		return nil
	}
	if _, err := e.savedLoginStatusForProfile(e.vault, profile); err != nil && !errors.Is(err, sessionvault.ErrNotRemembered) {
		if ignorableSavedLogin(err) {
			return nil
		}
		return ErrSavedLoginRefresh
	}
	processes, err := adapter.KnownProcesses(ctx)
	if err != nil {
		return ErrSavedLoginRefresh
	}
	if len(processes) > 0 {
		return nil
	}
	err = e.vault.RefreshSettled(profile.ID, profileExpectedRiotID(profile.RiotID))
	// Signed-out/other-account files are never a valid replacement. Keep the
	// previous encrypted save rather than mixing accounts or creating a save.
	if ignorableSavedLogin(err) {
		return nil
	}
	if err != nil {
		return ErrSavedLoginRefresh
	}
	return nil
}

func ignorableSavedLogin(err error) bool {
	return errors.Is(err, sessionvault.ErrNotFound) || errors.Is(err, sessionvault.ErrExpired) || errors.Is(err, sessionvault.ErrUnverified) || errors.Is(err, sessionvault.ErrIdentityMismatch) || errors.Is(err, sessionvault.ErrNotRemembered)
}

func (e *Engine) prepareLogin(ctx context.Context, adapter platform.Adapter, profile settings.LaunchProfile, options RunOptions) error {
	if e.vault == nil {
		return nil
	}
	if options.FreshLogin {
		return e.vault.PrepareFreshLogin(profile.ID, profileExpectedRiotID(profile.RiotID))
	}
	if !options.RestoreSavedLogin {
		return e.refreshStoppedProfile(ctx, adapter, profile)
	}
	// Selecting the current account is also a switch action in the UI. Adopt
	// its settled state before restoring so Launch cannot roll it backwards.
	if err := e.refreshStoppedProfile(ctx, adapter, profile); err != nil {
		return err
	}
	_, err := e.vault.LoginStatus(profile.ID)
	if err == nil {
		err = e.vault.Restore(profile.ID, profileExpectedRiotID(profile.RiotID))
	}
	if errors.Is(err, sessionvault.ErrNotFound) || errors.Is(err, sessionvault.ErrExpired) || errors.Is(err, sessionvault.ErrNotRemembered) {
		return e.vault.PrepareFreshLogin(profile.ID, profileExpectedRiotID(profile.RiotID))
	}
	return err
}
