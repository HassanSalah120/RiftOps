//go:build desktop

package main

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/model"
	"github.com/HassanSalah120/RiftOps/internal/settings"
)

func TestLaunchGameArgsUsesValidatedProfileLocaleOnce(t *testing.T) {
	profile := settings.NewProfile("EUW")
	profile.DefaultGame = model.GameLeague
	profile.GameArgs = []string{"--fullscreen", "--locale=de_DE", "--locale", "fr_FR", "--no-splash"}
	profile.LeagueLocale = "en_US"
	got := launchGameArgs(profile)
	want := []string{"--fullscreen", "--no-splash", "--locale=en_US"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("launchGameArgs() = %#v, want %#v", got, want)
	}
}

func TestLaunchGameArgsKeepsGameArgsWhenLocaleIsAutomatic(t *testing.T) {
	profile := settings.NewProfile("EUW")
	profile.GameArgs = []string{"--fullscreen"}
	profile.LeagueLocale = settings.DefaultLeagueLocale
	if got, want := launchGameArgs(profile), profile.GameArgs; !reflect.DeepEqual(got, want) {
		t.Fatalf("launchGameArgs() = %#v, want %#v", got, want)
	}
}

func TestCustomStartRejectsNonPostBeforeTouchingLCU(t *testing.T) {
	recorder := httptest.NewRecorder()
	lcuCustomStartHandler(recorder, httptest.NewRequest(http.MethodGet, "/api/lcu/custom-start", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET custom start returned %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
}
