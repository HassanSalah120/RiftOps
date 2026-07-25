package model

import (
	"fmt"
	"strings"
)

type Game string

const (
	GameAuto       Game = "auto"
	GamePrompt     Game = "prompt"
	GameLeague     Game = "lol"
	GameRuneterra  Game = "lor"
	GameValorant   Game = "valorant"
	Game2XKO       Game = "lion"
	GameRiotClient Game = "riot-client"
)

func ParseGame(value string) (Game, error) {
	switch Game(strings.ToLower(strings.TrimSpace(value))) {
	case GameAuto:
		return GameAuto, nil
	case GamePrompt:
		return GamePrompt, nil
	case GameLeague, "league", "league_of_legends":
		return GameLeague, nil
	case GameRuneterra, "runeterra", "bacon":
		return GameRuneterra, nil
	case GameValorant:
		return GameValorant, nil
	case Game2XKO, "2xko":
		return Game2XKO, nil
	case GameRiotClient, "riotclient", "riot":
		return GameRiotClient, nil
	default:
		return "", fmt.Errorf("unsupported game %q", value)
	}
}

func (g Game) Product() (string, bool) {
	switch g {
	case GameLeague:
		return "league_of_legends", true
	case GameRuneterra:
		return "bacon", true
	case GameValorant:
		return "valorant", true
	case Game2XKO:
		return "lion", true
	case GameRiotClient:
		return "", false
	default:
		return "", false
	}
}
