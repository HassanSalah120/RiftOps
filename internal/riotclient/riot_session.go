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

func (lf *Lockfile) FetchRiotAccountSession(ctx context.Context) (RiotAccountSession, error) {
	if lf == nil || lf.Source != "riot-client" {
		return RiotAccountSession{}, errors.New("Riot Client session is unavailable")
	}
	data, err := lf.DoRequest(ctx, "GET", "/player-session-lifecycle/v1/session")
	if err != nil {
		return RiotAccountSession{}, errors.New("Riot Client session could not be read")
	}
	var value struct {
		LoginState string `json:"loginState"`
		PUUID      string `json:"puuid"`
		RiotID     struct {
			GameName string `json:"gameName"`
			TagLine  string `json:"tagLine"`
		} `json:"riotID"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return RiotAccountSession{}, errors.New("Riot Client session response was invalid")
	}
	if !strings.EqualFold(value.LoginState, "authorized") {
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
