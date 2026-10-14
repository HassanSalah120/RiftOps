package riotclient

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

// RiotAccountSession contains only the identity needed to bind a saved login.
// The Riot response also contains authentication material; never return it.
type RiotAccountSession struct {
	PUUID      string
	RiotID     string
	Authorized bool
}

type riotAccountResponse struct {
	LoginState string `json:"loginState"`
	PUUID      string `json:"puuid"`
	RiotID     struct {
		GameName string `json:"gameName"`
		TagLine  string `json:"tagLine"`
	} `json:"riotID"`
}

func (lf *Lockfile) FetchRiotAccountSession(ctx context.Context) (RiotAccountSession, error) {
	if lf == nil || lf.Source != "riot-client" {
		return RiotAccountSession{}, errors.New("Riot Client session is unavailable")
	}
	data, err := lf.DoRequest(ctx, "GET", "/player-session-lifecycle/v1/session")
	if err != nil {
		return RiotAccountSession{}, errors.New("Riot Client session could not be read")
	}
	var value riotAccountResponse
	if err := json.Unmarshal(data, &value); err != nil {
		return RiotAccountSession{}, errors.New("Riot Client session response was invalid")
	}
	if strings.EqualFold(value.LoginState, "PendingProductContext") {
		// Some clients remain in this state after sign-in, until a product is
		// selected. RSO must independently confirm completed authentication.
		rsoData, err := lf.DoRequest(ctx, "GET", "/rso-auth/v1/session")
		if err != nil {
			return RiotAccountSession{}, errors.New("Riot Client authentication could not be verified")
		}
		var rso struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(rsoData, &rso) != nil || !strings.EqualFold(rso.Type, "authenticated") {
			return RiotAccountSession{}, nil
		}
		// Ensure the named account did not change between these two endpoints.
		currentData, err := lf.DoRequest(ctx, "GET", "/player-session-lifecycle/v1/session")
		var current riotAccountResponse
		if err != nil || json.Unmarshal(currentData, &current) != nil || current.PUUID != value.PUUID || current.RiotID != value.RiotID ||
			(!strings.EqualFold(current.LoginState, "PendingProductContext") && !strings.EqualFold(current.LoginState, "authorized")) {
			return RiotAccountSession{}, errors.New("Riot Client account changed during verification")
		}
	} else if !strings.EqualFold(value.LoginState, "authorized") {
		return RiotAccountSession{}, nil
	}
	identity := RiotAccountSession{
		PUUID:      strings.TrimSpace(value.PUUID),
		RiotID:     strings.TrimSpace(value.RiotID.GameName) + "#" + strings.TrimSpace(value.RiotID.TagLine),
		Authorized: true,
	}
	if identity.PUUID == "" || len(identity.PUUID) > 128 ||
		strings.TrimSpace(value.RiotID.GameName) == "" || strings.TrimSpace(value.RiotID.TagLine) == "" ||
		len(identity.RiotID) > 160 || strings.ContainsAny(identity.PUUID+identity.RiotID, "\r\n\x00") {
		return RiotAccountSession{}, errors.New("Riot Client did not provide a complete account identity")
	}
	return identity, nil
}

// CurrentRiotAccountSession uses the Riot Client lockfile specifically. The
// League LCU lockfile can belong to a different client process and must not be
// used to identify the remembered Riot login.
func CurrentRiotAccountSession(ctx context.Context) (RiotAccountSession, error) {
	for _, path := range riotClientLockfileCandidates(LockfileSearchBases()) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lf, err := parseLockfile(strings.TrimSpace(string(data)))
		if err != nil {
			continue
		}
		lf.Source = "riot-client"
		identity, err := lf.FetchRiotAccountSession(ctx)
		if err == nil {
			return identity, nil
		}
	}
	return RiotAccountSession{}, errors.New("Riot Client is not available for account verification")
}

// QuitRiotClient asks Riot to persist its session before exiting. This never
// signs out or revokes authentication; callers decide whether force-close is
// necessary after waiting for the processes to disappear.
func QuitRiotClient(ctx context.Context) error {
	for _, path := range riotClientLockfileCandidates(LockfileSearchBases()) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lf, err := parseLockfile(strings.TrimSpace(string(data)))
		if err != nil {
			continue
		}
		lf.Source = "riot-client"
		if err := lf.Quit(ctx); err == nil {
			return nil
		}
	}
	return errors.New("Riot Client could not be asked to close gracefully")
}

func (lf *Lockfile) Quit(ctx context.Context) error {
	if lf == nil || lf.Source != "riot-client" {
		return errors.New("Riot Client shutdown is unavailable")
	}
	_, err := lf.DoRequest(ctx, "POST", "/process-control/v1/process/quit")
	if err != nil {
		return errors.New("Riot Client graceful shutdown request failed")
	}
	return nil
}
