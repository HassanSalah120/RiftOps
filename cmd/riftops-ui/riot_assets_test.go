//go:build desktop

package main

import "testing"

func TestBuildProfileBackgroundSkinsUsesCatalogueAssetPath(t *testing.T) {
	inventory := []byte(`[{"id":266001,"name":"Justicar Aatrox"}]`)
	catalogue := []byte(`{"266001":{"id":266001,"name":"Justicar Aatrox","splashPath":"/lol-game-data/assets/ASSETS/Characters/Aatrox/Skins/Skin01/Images/aatrox_splash_centered_1.jpg","uncenteredSplashPath":"/lol-game-data/assets/ASSETS/Characters/Aatrox/Skins/Skin01/Images/aatrox_splash_uncentered_1.jpg"}}`)
	skins, err := buildProfileBackgroundSkins(inventory, catalogue)
	if err != nil {
		t.Fatal(err)
	}
	if len(skins) != 1 {
		t.Fatalf("got %d skins, want 1", len(skins))
	}
	if got := skins[0].PreviewAssetPath; got != "/lol-game-data/assets/ASSETS/Characters/Aatrox/Skins/Skin01/Images/aatrox_splash_uncentered_1.jpg" {
		t.Fatalf("unexpected preview path %q", got)
	}
}

func TestBuildProfileBackgroundSkinsRejectsFabricatedAssetPaths(t *testing.T) {
	inventory := []byte(`[{"id":266001,"name":"Justicar Aatrox","splashPath":"https://example.invalid/guessed.jpg"}]`)
	skins, err := buildProfileBackgroundSkins(inventory, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(skins) != 1 || skins[0].PreviewAssetPath != "" {
		t.Fatalf("external asset path was accepted: %#v", skins)
	}
}
