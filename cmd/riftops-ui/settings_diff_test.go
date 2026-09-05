//go:build desktop

package main

import (
	"reflect"
	"sort"
	"testing"
)

func TestSettingsDiffPathsListsChangedLeavesWithoutValues(t *testing.T) {
	got := settingsDiffPaths("game", []byte(`{"video":{"width":1920,"height":1080},"sound":true}`), []byte(`{"video":{"width":2560,"height":1080},"sound":false}`))
	sort.Strings(got)
	want := []string{"game.sound", "game.video.width"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("settings diff = %v, want %v", got, want)
	}
}
