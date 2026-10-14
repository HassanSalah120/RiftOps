package featurestore

import (
	"strings"
	"time"
)

type QueueRank struct {
	Tier         string `json:"tier"`
	Division     string `json:"division,omitempty"`
	LeaguePoints int    `json:"leaguePoints"`
}

// AccountRank holds the last successful League read, not authentication data.
type AccountRank struct {
	Solo      QueueRank `json:"solo"`
	Flex      QueueRank `json:"flex"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// RankKey separates accounts and servers without persisting account names.
func RankKey(riotID, region string) string {
	return AccountKey("rank\x00" + strings.ToLower(strings.TrimSpace(riotID)) + "\x00" + strings.ToUpper(strings.TrimSpace(region)))
}
