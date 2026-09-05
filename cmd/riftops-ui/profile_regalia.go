package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/HassanSalah120/RiftOps/internal/featurestore"
	"github.com/HassanSalah120/RiftOps/internal/riotclient"
)

type profileRegaliaChoice struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	AssetPath   string `json:"assetPath,omitempty"`
	RegaliaType string `json:"regaliaType,omitempty"`
}

type profileRegaliaInventory struct {
	Current  map[string]any         `json:"current"`
	Titles   []profileRegaliaChoice `json:"titles"`
	Tokens   []profileRegaliaChoice `json:"tokens"`
	Banners  []profileRegaliaChoice `json:"banners"`
	Crests   []profileRegaliaChoice `json:"crests"`
	Mutation string                 `json:"mutation"`
}

func decodeJSONObject(body []byte) map[string]any {
	var decoded map[string]any
	if json.Unmarshal(body, &decoded) != nil {
		return map[string]any{}
	}
	return decoded
}

func stringField(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func numericStringField(record map[string]any, keys ...string) string {
	for _, key := range keys {
		switch value := record[key].(type) {
		case string:
			if parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil && parsed > 0 {
				return strconv.FormatInt(parsed, 10)
			}
		case float64:
			if value > 0 && value == float64(int64(value)) {
				return strconv.FormatInt(int64(value), 10)
			}
		}
	}
	return ""
}

func recordSelectable(record map[string]any) bool {
	for _, key := range []string{"owned", "isOwned", "isSelectable"} {
		if value, present := record[key]; present {
			if allowed, ok := value.(bool); ok && !allowed {
				return false
			}
		}
	}
	for _, key := range []string{"level", "currentLevel", "status", "ownershipType"} {
		value := strings.ToUpper(strings.TrimSpace(fmt.Sprint(record[key])))
		if value == "NONE" || strings.Contains(value, "NOT_OWNED") || strings.Contains(value, "UNOWNED") || strings.Contains(value, "LOCKED") {
			return false
		}
	}
	return true
}

func collectNumericChoices(value any, idKeys []string, target map[string]profileRegaliaChoice) {
	switch current := value.(type) {
	case []any:
		for _, child := range current {
			collectNumericChoices(child, idKeys, target)
		}
	case map[string]any:
		if recordSelectable(current) {
			if id := numericStringField(current, idKeys...); id != "" {
				name := stringField(current, "name", "title", "localizedName", "challengeName")
				if name == "" {
					name = "#" + id
				}
				target[id] = profileRegaliaChoice{ID: id, Name: name, Description: stringField(current, "description", "localizedDescription", "challengeDescription"), AssetPath: stringField(current, "assetPath", "iconPath")}
			}
		}
		for _, child := range current {
			collectNumericChoices(child, idKeys, target)
		}
	}
}

func collectInventoryChoices(body []byte) []profileRegaliaChoice {
	var raw any
	if json.Unmarshal(body, &raw) != nil {
		return nil
	}
	choices := make(map[string]profileRegaliaChoice)
	var visit func(any, string, bool)
	visit = func(value any, envelopeID string, parentOwned bool) {
		switch current := value.(type) {
		case []any:
			for _, child := range current {
				visit(child, envelopeID, parentOwned)
			}
		case map[string]any:
			owned := parentOwned && recordSelectable(current)
			if parentOwned {
				if explicit, ok := current["isOwned"].(bool); ok {
					owned = explicit
				}
			} else {
				// An explicitly unowned envelope cannot be made owned by a
				// nested item record; keep the ownership boundary sticky.
				owned = false
			}
			if owned {
				id := envelopeID
				if candidate := stringField(current, "idSecondary", "id"); candidate != "" {
					id = candidate
				}
				if id != "" {
					name := stringField(current, "localizedName", "name")
					if name == "" {
						name = "#" + id
					}
					choices[id] = profileRegaliaChoice{ID: id, Name: name, Description: stringField(current, "localizedDescription", "description"), AssetPath: stringField(current, "assetPath", "iconPath"), RegaliaType: stringField(current, "regaliaType", "type")}
				}
			}
			for key, child := range current {
				nextEnvelope := envelopeID
				if key != "items" && envelopeID == "" {
					nextEnvelope = key
				}
				visit(child, nextEnvelope, owned)
			}
		}
	}
	visit(raw, "", true)
	result := make([]profileRegaliaChoice, 0, len(choices))
	for _, choice := range choices {
		result = append(result, choice)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func sortedChoices(values map[string]profileRegaliaChoice) []profileRegaliaChoice {
	result := make([]profileRegaliaChoice, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func loadProfileRegaliaInventory(ctx context.Context, lf *riotclient.Lockfile) (profileRegaliaInventory, error) {
	regaliaBody, regaliaErr := lf.FetchProfileRegalia(ctx)
	summaryBody, summaryErr := lf.FetchChallengeSummary(ctx)
	titlesBody, titlesErr := lf.FetchChallengeTitles(ctx)
	tokensBody, tokensErr := lf.FetchChallengeTokens(ctx)
	if regaliaErr != nil && summaryErr != nil && titlesErr != nil && tokensErr != nil {
		return profileRegaliaInventory{}, fmt.Errorf("profile regalia is unavailable")
	}
	titleChoices := make(map[string]profileRegaliaChoice)
	tokenChoices := make(map[string]profileRegaliaChoice)
	var value any
	if json.Unmarshal(titlesBody, &value) == nil {
		collectNumericChoices(value, []string{"itemId", "id"}, titleChoices)
	}
	if json.Unmarshal(tokensBody, &value) == nil {
		collectNumericChoices(value, []string{"id", "challengeId"}, tokenChoices)
	}
	bannersBody, _ := lf.FetchRegaliaInventory(ctx, "REGALIA_BANNER")
	crestsBody, _ := lf.FetchRegaliaInventory(ctx, "REGALIA_CREST")
	current := decodeJSONObject(summaryBody)
	for key, item := range decodeJSONObject(regaliaBody) {
		current[key] = item
	}
	return profileRegaliaInventory{Current: current, Titles: sortedChoices(titleChoices), Tokens: sortedChoices(tokenChoices), Banners: collectInventoryChoices(bannersBody), Crests: collectInventoryChoices(crestsBody), Mutation: "ownership-checked"}, nil
}

func hasChoice(choices []profileRegaliaChoice, id string) bool {
	id = strings.TrimSpace(id)
	for _, choice := range choices {
		if choice.ID == id {
			return true
		}
	}
	return false
}

func applyOwnedProfileRegalia(ctx context.Context, lf *riotclient.Lockfile, preset featurestore.ProfilePreset) map[string]string {
	results := map[string]string{}
	inventory, err := loadProfileRegaliaInventory(ctx, lf)
	if err != nil {
		if preset.TitleID > 0 || preset.TokenIDs != nil || preset.BannerAccent != "" || preset.PreferredCrestType != "" {
			results["regalia"] = "unavailable: ownership could not be verified for this League patch"
		}
		return results
	}
	if preset.TitleID > 0 {
		id := strconv.Itoa(preset.TitleID)
		if !hasChoice(inventory.Titles, id) {
			results["title"] = "skipped: title is not verified as owned"
		} else if err := lf.UpdateChallengePreferences(ctx, id, nil, ""); err != nil {
			results["title"] = "failed"
		} else {
			results["title"] = "applied"
		}
	}
	if preset.TokenIDs != nil {
		owned := true
		for _, id := range preset.TokenIDs {
			owned = owned && hasChoice(inventory.Tokens, strconv.Itoa(id))
		}
		if !owned {
			results["tokens"] = "skipped: one or more tokens are not verified as owned"
		} else if err := lf.UpdateChallengePreferences(ctx, "", preset.TokenIDs, ""); err != nil {
			results["tokens"] = "failed"
		} else {
			results["tokens"] = "applied"
		}
	}
	if preset.BannerAccent != "" {
		if !hasChoice(inventory.Banners, preset.BannerAccent) {
			results["bannerAccent"] = "skipped: banner is not verified as owned"
		} else if err := lf.UpdateChallengePreferences(ctx, "", nil, preset.BannerAccent); err != nil {
			results["bannerAccent"] = "failed"
		} else {
			results["bannerAccent"] = "applied"
		}
	}
	if preset.PreferredCrestType != "" || preset.PreferredBannerType != "" || preset.SelectedPrestigeCrest > 0 {
		crestOwned := preset.SelectedPrestigeCrest == 0 || hasChoice(inventory.Crests, strconv.Itoa(preset.SelectedPrestigeCrest))
		crestTypeOwned := preset.PreferredCrestType == "" || stringField(inventory.Current, "preferredCrestType") == preset.PreferredCrestType
		for _, choice := range inventory.Crests {
			crestTypeOwned = crestTypeOwned || choice.RegaliaType == preset.PreferredCrestType
		}
		bannerTypeOwned := preset.PreferredBannerType == "" || stringField(inventory.Current, "preferredBannerType", "bannerType") == preset.PreferredBannerType
		for _, choice := range inventory.Banners {
			bannerTypeOwned = bannerTypeOwned || choice.RegaliaType == preset.PreferredBannerType
		}
		if !crestOwned || !crestTypeOwned || !bannerTypeOwned {
			results["crest"] = "skipped: crest or banner type is not verified as owned"
		} else {
			bannerType := preset.PreferredBannerType
			if bannerType == "" {
				bannerType = stringField(inventory.Current, "preferredBannerType", "bannerType")
			}
			crestType := preset.PreferredCrestType
			if crestType == "" {
				crestType = stringField(inventory.Current, "preferredCrestType", "crestType")
			}
			if err := lf.UpdateProfileRegalia(ctx, bannerType, crestType, preset.SelectedPrestigeCrest); err != nil {
				results["crest"] = "failed"
			} else {
				results["crest"] = "applied"
			}
		}
	}
	return results
}
