//go:build desktop

package main

import (
	"context"
	"strings"
	"time"

	"github.com/HassanSalah120/RiftOps/internal/featurestore"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

type rankedLaunchProfile struct {
	settings.LaunchProfile
	Rank *featurestore.AccountRank `json:"rank,omitempty"`
}

func profilesWithRanks(profiles []settings.LaunchProfile, ranks map[string]featurestore.AccountRank) []rankedLaunchProfile {
	result := make([]rankedLaunchProfile, 0, len(profiles))
	for _, profile := range profiles {
		item := rankedLaunchProfile{LaunchProfile: profile}
		if profile.RiotID != "" && profile.Region != "" {
			if rank, ok := ranks[featurestore.RankKey(profile.RiotID, profile.Region)]; ok {
				item.Rank = &rank
			}
		}
		result = append(result, item)
	}
	return result
}

func queueRanks(entries []riotclient.LCULeagueEntry) featurestore.AccountRank {
	rank := featurestore.AccountRank{
		Solo:      featurestore.QueueRank{Tier: "UNRANKED"},
		Flex:      featurestore.QueueRank{Tier: "UNRANKED"},
		UpdatedAt: time.Now().UTC(),
	}
	for _, entry := range entries {
		value := featurestore.QueueRank{Tier: strings.ToUpper(strings.TrimSpace(entry.Tier)), Division: entry.Rank, LeaguePoints: entry.LeaguePoints}
		if value.Division == "" {
			value.Division = entry.Division
		}
		if value.Tier == "" || value.Tier == "NONE" {
			value = featurestore.QueueRank{Tier: "UNRANKED"}
		}
		switch entry.QueueType {
		case "RANKED_SOLO_5x5":
			rank.Solo = value
		case "RANKED_FLEX_SR":
			rank.Flex = value
		}
	}
	return rank
}

// refreshAccountRank only caches a successful, identity-stable League read.
// Failures leave previously checked ranks available for offline accounts.
func refreshAccountRank(ctx context.Context, lf *riotclient.Lockfile, store *featurestore.Store, readRiot func(context.Context) (riotclient.RiotAccountSession, error)) {
	if store == nil || lf == nil || lf.Source != "league" {
		return
	}
	before, err := lf.FetchConnectedLeagueAccount(ctx)
	if err != nil {
		return
	}
	riot, err := readRiot(ctx)
	if err != nil || !connectedAccountMatches(before, riot) {
		return
	}
	entries, err := lf.FetchLCULeague(ctx, before.PUUID)
	if err != nil || entries == nil {
		return
	}
	after, err := lf.FetchConnectedLeagueAccount(ctx)
	if err != nil || after.PUUID != before.PUUID || after.Region != before.Region {
		return
	}
	current, err := readRiot(ctx)
	if err != nil || !connectedAccountMatches(after, current) || !sameAccountRiotID(riot.RiotID, current.RiotID) {
		return
	}
	key := featurestore.RankKey(current.RiotID, after.Region)
	_ = store.Update(func(data *featurestore.Data) error {
		if data.AccountRanks == nil {
			data.AccountRanks = make(map[string]featurestore.AccountRank)
		}
		data.AccountRanks[key] = queueRanks(entries)
		return nil
	})
}

func sameAccountRiotID(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}
