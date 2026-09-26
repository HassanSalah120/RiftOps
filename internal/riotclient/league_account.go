package riotclient

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// ConnectedLeagueAccount is the account and server reported by the running
// League client. Only that connected account can have its server detected.
type ConnectedLeagueAccount struct {
	PUUID  string `json:"-"`
	RiotID string `json:"riotId"`
	Region string `json:"region"`
}

var leaguePlatforms = map[string]string{
	"BR": "BR1", "EUNE": "EUN1", "EUW": "EUW1", "JP": "JP1",
	"KR": "KR", "LAN": "LA1", "LAS": "LA2", "NA": "NA1",
	"OCE": "OC1", "TR": "TR1", "RU": "RU", "PH": "PH2",
	"SG": "SG2", "TH": "TH2", "TW": "TW2", "VN": "VN2",
}

// NormalizeLeagueRegion converts the League client's short region to Riot's
// platform ID. Unknown values remain unknown; never default to EUW/NA.
func NormalizeLeagueRegion(region string) string {
	value := strings.ToUpper(strings.TrimSpace(region))
	if platform, ok := leaguePlatforms[value]; ok {
		return platform
	}
	for _, platform := range leaguePlatforms {
		if value == platform {
			return platform
		}
	}
	return ""
}

func (lf *Lockfile) FetchConnectedLeagueAccount(ctx context.Context) (ConnectedLeagueAccount, error) {
	if lf == nil || lf.Source != "league" {
		return ConnectedLeagueAccount{}, errors.New("League Client is not connected")
	}
	summoner, err := lf.FetchLCUSummoner(ctx)
	if err != nil || summoner == nil || strings.TrimSpace(summoner.PUUID) == "" {
		return ConnectedLeagueAccount{}, errors.New("League account identity is not ready")
	}
	body, err := lf.DoRequest(ctx, "GET", "/riotclient/region-locale")
	if err != nil {
		return ConnectedLeagueAccount{}, errors.New("League server could not be detected")
	}
	var locale struct {
		Region string `json:"region"`
	}
	if json.Unmarshal(body, &locale) != nil {
		return ConnectedLeagueAccount{}, errors.New("League server response was invalid")
	}
	region := NormalizeLeagueRegion(locale.Region)
	if region == "" {
		return ConnectedLeagueAccount{}, errors.New("League reported an unsupported server")
	}
	riotID := ""
	if strings.TrimSpace(summoner.GameName) != "" && strings.TrimSpace(summoner.TagLine) != "" {
		riotID = strings.TrimSpace(summoner.GameName) + "#" + strings.TrimSpace(summoner.TagLine)
	}
	return ConnectedLeagueAccount{
		PUUID:  strings.TrimSpace(summoner.PUUID),
		RiotID: riotID,
		Region: region,
	}, nil
}
