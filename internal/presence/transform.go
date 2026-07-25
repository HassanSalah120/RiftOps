package presence

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/xmpp"
)

type Options struct {
	Status       model.Status
	ConnectToMUC bool
}

type Result struct {
	Raw             []byte
	Drop            bool
	Changed         bool
	ValorantVersion string
}

func Transform(raw []byte, options Options) (Result, error) {
	if !options.Status.Valid() {
		return Result{}, fmt.Errorf("invalid target status %q", options.Status)
	}
	root, err := xmpp.ParseElement(raw)
	if err != nil {
		return Result{}, fmt.Errorf("parse presence: %w", err)
	}
	if root.LocalName() != "presence" {
		return Result{Raw: raw}, nil
	}
	if _, directed := root.Attr("to"); directed {
		if options.ConnectToMUC {
			return Result{Raw: raw}, nil
		}
		return Result{Drop: true, Changed: true}, nil
	}

	show := root.Child("show")
	games := root.Child("games")
	league := child(games, "league_of_legends")
	leagueState := child(league, "st")
	preserveDND := options.Status == model.StatusOnline && leagueState != nil && leagueState.Text() == "dnd"
	if !preserveDND {
		if show != nil {
			show.SetText(string(options.Status))
		}
		if leagueState != nil {
			leagueState.SetText(string(options.Status))
		}
	}

	if options.Status == model.StatusOnline {
		encoded, err := root.Encode()
		return Result{Raw: encoded, Changed: true}, err
	}

	root.RemoveChildren("status")
	valorantVersion := extractValorantVersion(child(games, "valorant"))
	if games != nil {
		if options.Status == model.StatusMobile {
			if league != nil {
				league.RemoveChildren("p", "m")
			}
		} else {
			games.RemoveChildren("league_of_legends")
		}
		games.RemoveChildren("bacon", "lion", "keystone", "riot_client", "valorant")
	}
	encoded, err := root.Encode()
	if err != nil {
		return Result{}, err
	}
	return Result{Raw: encoded, Changed: true, ValorantVersion: valorantVersion}, nil
}

func child(parent *xmpp.Element, name string) *xmpp.Element {
	if parent == nil {
		return nil
	}
	return parent.Child(name)
}

func extractValorantVersion(valorant *xmpp.Element) string {
	presence := child(valorant, "p")
	if presence == nil || presence.Text() == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(presence.Text())
	if err != nil {
		return ""
	}
	var data struct {
		Party struct {
			Version string `json:"partyClientVersion"`
		} `json:"partyPresenceData"`
	}
	if json.Unmarshal(decoded, &data) != nil {
		return ""
	}
	return data.Party.Version
}
