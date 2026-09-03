package settings

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/HassanSalah120/RiftOps/internal/model"
)

const DefaultProfileID = "default"

type LaunchProfile struct {
	ID             string                      `json:"id"`
	Name           string                      `json:"name"`
	AccountLabel   string                      `json:"accountLabel,omitempty"`
	RiotID         string                      `json:"riotId,omitempty"`
	Region         string                      `json:"region,omitempty"`
	Enabled        bool                        `json:"enabled"`
	Status         model.Status                `json:"status"`
	DefaultGame    model.Game                  `json:"defaultGame"`
	StartupStatus  StartupStatus               `json:"startupStatus"`
	ConnectToMUC   bool                        `json:"connectToMUC"`
	Patchline      string                      `json:"patchline"`
	LeagueLocale   string                      `json:"leagueLocale,omitempty"`
	RiotClientArgs []string                    `json:"riotClientArgs,omitempty"`
	GameArgs       []string                    `json:"gameArgs,omitempty"`
	GameStatuses   map[model.Game]model.Status `json:"gameStatuses,omitempty"`
}

const DefaultLeagueLocale = "auto"

var supportedLeagueLocales = map[string]struct{}{
	"auto": {}, "cs_CZ": {}, "de_DE": {}, "el_GR": {}, "en_AU": {},
	"en_GB": {}, "en_PH": {}, "en_SG": {}, "en_US": {}, "es_AR": {},
	"es_ES": {}, "es_MX": {}, "fr_FR": {}, "hu_HU": {}, "it_IT": {},
	"ja_JP": {}, "ko_KR": {}, "pl_PL": {}, "pt_BR": {}, "ro_RO": {},
	"ru_RU": {}, "th_TH": {}, "tr_TR": {}, "vi_VN": {}, "zh_CN": {},
	"zh_MY": {}, "zh_TW": {},
}

func SupportedLeagueLocales() []string {
	result := make([]string, 0, len(supportedLeagueLocales))
	for locale := range supportedLeagueLocales {
		result = append(result, locale)
	}
	sort.Strings(result)
	return result
}

func NewProfile(name string) LaunchProfile {
	return LaunchProfile{
		ID: NewProfileID(), Name: strings.TrimSpace(name), Enabled: true,
		Status: model.StatusOffline, DefaultGame: model.GameLeague,
		StartupStatus: StartupLast, ConnectToMUC: true, Patchline: "live",
		LeagueLocale: DefaultLeagueLocale,
		GameStatuses: make(map[model.Game]model.Status),
	}
}

func NewProfileID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err == nil {
		return "profile-" + hex.EncodeToString(buffer)
	}
	return DefaultProfileID
}

func (p LaunchProfile) Validate() error {
	p.ID = strings.TrimSpace(p.ID)
	p.Name = strings.TrimSpace(p.Name)
	if p.ID == "" {
		return fmt.Errorf("profile ID is required")
	}
	if p.Name == "" || len([]rune(p.Name)) > 48 {
		return fmt.Errorf("profile name must contain 1 to 48 characters")
	}
	if len([]rune(p.AccountLabel)) > 80 || len([]rune(p.RiotID)) > 80 || len([]rune(p.Region)) > 24 {
		return fmt.Errorf("profile account details are too long")
	}
	if !p.Status.Valid() {
		return fmt.Errorf("invalid profile status %q", p.Status)
	}
	if p.StartupStatus != StartupLast {
		if _, err := model.ParseStatus(string(p.StartupStatus)); err != nil {
			return fmt.Errorf("invalid profile startup status %q", p.StartupStatus)
		}
	}
	if _, err := model.ParseGame(string(p.DefaultGame)); err != nil {
		return err
	}
	if strings.TrimSpace(p.Patchline) == "" || len(p.Patchline) > 32 {
		return fmt.Errorf("profile patchline is invalid")
	}
	locale := strings.TrimSpace(p.LeagueLocale)
	if locale == "" {
		locale = DefaultLeagueLocale
	}
	if _, ok := supportedLeagueLocales[locale]; !ok {
		return fmt.Errorf("unsupported League locale %q", p.LeagueLocale)
	}
	if err := validateArguments(p.RiotClientArgs); err != nil {
		return fmt.Errorf("Riot Client arguments: %w", err)
	}
	if err := validateArguments(p.GameArgs); err != nil {
		return fmt.Errorf("game arguments: %w", err)
	}
	for game, status := range p.GameStatuses {
		if _, err := model.ParseGame(string(game)); err != nil {
			return fmt.Errorf("game statuses: %w", err)
		}
		if !status.Valid() {
			return fmt.Errorf("game statuses: invalid status %q for game %q", status, game)
		}
	}
	return nil
}

func validateArguments(arguments []string) error {
	if len(arguments) > 32 {
		return fmt.Errorf("too many arguments")
	}
	for _, argument := range arguments {
		if len(argument) > 512 {
			return fmt.Errorf("an argument is too long")
		}
		lower := strings.ToLower(argument)
		for _, sensitive := range []string{"password", "passwd", "access-token", "auth-token", "authorization", "session-token"} {
			if strings.Contains(lower, sensitive) {
				return fmt.Errorf("credentials and tokens cannot be saved")
			}
		}
	}
	return nil
}

func (s Settings) ActiveProfile() LaunchProfile {
	for _, profile := range s.Profiles {
		if profile.ID == s.ActiveProfileID {
			return profile
		}
	}
	return profileFromSettings(s, DefaultProfileID, "Default")
}

func (s *Settings) SelectProfile(id string) error {
	for _, profile := range s.Profiles {
		if profile.ID == id {
			s.ActiveProfileID = id
			s.applyProfile(profile)
			return nil
		}
	}
	return fmt.Errorf("launch profile %q was not found", id)
}

func (s *Settings) UpsertProfile(profile LaunchProfile) error {
	profile.ID = strings.TrimSpace(profile.ID)
	profile.Name = strings.TrimSpace(profile.Name)
	profile.AccountLabel = strings.TrimSpace(profile.AccountLabel)
	profile.RiotID = strings.TrimSpace(profile.RiotID)
	profile.Region = strings.ToUpper(strings.TrimSpace(profile.Region))
	profile.Patchline = strings.TrimSpace(profile.Patchline)
	profile.LeagueLocale = strings.TrimSpace(profile.LeagueLocale)
	if profile.LeagueLocale == "" {
		profile.LeagueLocale = DefaultLeagueLocale
	}
	if err := profile.Validate(); err != nil {
		return err
	}
	for _, existing := range s.Profiles {
		if existing.ID != profile.ID && strings.EqualFold(existing.Name, profile.Name) {
			return fmt.Errorf("a launch profile named %q already exists", profile.Name)
		}
	}
	for index := range s.Profiles {
		if s.Profiles[index].ID == profile.ID {
			s.Profiles[index] = profile
			if s.ActiveProfileID == profile.ID {
				s.applyProfile(profile)
			}
			return nil
		}
	}
	s.Profiles = append(s.Profiles, profile)
	return nil
}

func (s *Settings) DeleteProfile(id string) error {
	if len(s.Profiles) <= 1 {
		return fmt.Errorf("at least one launch profile is required")
	}
	index := -1
	for candidate := range s.Profiles {
		if s.Profiles[candidate].ID == id {
			index = candidate
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("launch profile %q was not found", id)
	}
	s.Profiles = append(s.Profiles[:index], s.Profiles[index+1:]...)
	if s.ActiveProfileID == id {
		s.ActiveProfileID = s.Profiles[0].ID
		s.applyProfile(s.Profiles[0])
	}
	return nil
}

func (s *Settings) syncActiveProfile() {
	for index := range s.Profiles {
		if s.Profiles[index].ID == s.ActiveProfileID {
			profile := &s.Profiles[index]
			profile.Enabled, profile.Status = s.Enabled, s.Status
			profile.DefaultGame, profile.StartupStatus = s.DefaultGame, s.StartupStatus
			profile.ConnectToMUC = s.ConnectToMUC
			return
		}
	}
}

func (s *Settings) applyProfile(profile LaunchProfile) {
	s.Enabled, s.Status = profile.Enabled, profile.Status
	s.DefaultGame, s.StartupStatus = profile.DefaultGame, profile.StartupStatus
	s.ConnectToMUC = profile.ConnectToMUC
}

func (s *Settings) UpdateActiveRuntime(enabled bool, status model.Status) {
	s.Enabled, s.Status = enabled, status
	s.syncActiveProfile()
}

func (s *Settings) UpdateActivePreferences(game model.Game, startup StartupStatus, connectToMUC bool) {
	s.DefaultGame, s.StartupStatus = game, startup
	s.ConnectToMUC = connectToMUC
	s.syncActiveProfile()
}

func profileFromSettings(s Settings, id, name string) LaunchProfile {
	return LaunchProfile{
		ID: id, Name: name, Enabled: s.Enabled, Status: s.Status,
		DefaultGame: s.DefaultGame, StartupStatus: s.StartupStatus,
		ConnectToMUC: s.ConnectToMUC, Patchline: "live",
		LeagueLocale: DefaultLeagueLocale,
		GameStatuses: make(map[model.Game]model.Status),
	}
}
