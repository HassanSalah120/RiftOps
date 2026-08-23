package main

import "net/http"

type dashboardRoute struct {
	Pattern string
	Handler http.HandlerFunc
	API     bool
}

// dashboardRoutes is the single route inventory for both registration and
// phone-policy tests. New APIs are desktop-only by default: adding a handler
// here never grants it to the LAN listener unless it is also placed in one of
// remoteCapabilities' named groups.
func dashboardRoutes() []dashboardRoute {
	return []dashboardRoute{
		{Pattern: "/api/snapshot", Handler: getSnapshot, API: true},
		{Pattern: "/api/events", Handler: sseHandler, API: true},
		{Pattern: "/api/profiles", Handler: getProfiles, API: true},
		{Pattern: "/api/select-profile", Handler: selectProfile, API: true},
		{Pattern: "/api/save-profile", Handler: saveProfile, API: true},
		{Pattern: "/api/delete-profile", Handler: deleteProfile, API: true},
		{Pattern: "/api/profiles/export", Handler: exportProfiles, API: true},
		{Pattern: "/api/profiles/import", Handler: importProfiles, API: true},
		{Pattern: "/api/preferences", Handler: getPreferences, API: true},
		{Pattern: "/api/save-preferences", Handler: savePreferences, API: true},
		{Pattern: "/api/riot-client-location", Handler: riotClientLocationHandler, API: true},
		{Pattern: "/api/riot-client-location/detect", Handler: detectRiotClientLocation, API: true},
		{Pattern: "/api/riot-client-location/browse", Handler: browseRiotClientLocation, API: true},
		{Pattern: "/api/set-enabled", Handler: setEnabled, API: true},
		{Pattern: "/api/set-status", Handler: setStatus, API: true},
		{Pattern: "/api/start", Handler: startEngine, API: true},
		{Pattern: "/api/stop", Handler: stopEngine, API: true},
		{Pattern: "/api/capture-session", Handler: captureSession, API: true},
		{Pattern: "/api/forget-session", Handler: forgetSession, API: true},
		{Pattern: "/api/session-status", Handler: getSessionStatus, API: true},
		{Pattern: "/api/switch-profile", Handler: switchProfile, API: true},
		{Pattern: "/api/set-autostart", Handler: setAutostart, API: true},
		{Pattern: "/api/autostart", Handler: getAutostart, API: true},
		{Pattern: "/api/check-update", Handler: checkUpdate, API: true},
		{Pattern: "/api/remote/status", Handler: remoteStatusHandler, API: true},
		{Pattern: "/api/remote/qr.png", Handler: remoteQRHandler, API: true},
		{Pattern: "/api/remote/rotate", Handler: remoteRotateHandler, API: true},
		{Pattern: "/api/remote/sessions/revoke", Handler: remoteRevokeHandler, API: true},
		{Pattern: "/api/remote/sessions/revoke-all", Handler: remoteRevokeAllHandler, API: true},
		{Pattern: "/api/remote/enable", Handler: remoteEnableHandler, API: true},
		{Pattern: "/api/show", Handler: showApp, API: true},
		{Pattern: "/api/quit", Handler: quitApp, API: true},
		{Pattern: "/api/riot/account", Handler: riotAccountHandler, API: true},
		{Pattern: "/api/riot/summoner", Handler: riotSummonerHandler, API: true},
		{Pattern: "/api/riot/mastery", Handler: riotMasteryHandler, API: true},
		{Pattern: "/api/riot/league", Handler: riotLeagueHandler, API: true},
		{Pattern: "/api/riot/current-game", Handler: riotCurrentGameHandler, API: true},
		{Pattern: "/api/riot/status", Handler: riotStatusHandler, API: true},
		{Pattern: "/api/riot/configured", Handler: riotConfiguredHandler, API: true},
		{Pattern: "/api/ddragon/version", Handler: ddragonVersionHandler, API: true},
		{Pattern: "/api/ddragon/champions", Handler: ddragonChampionsHandler, API: true},
		{Pattern: "/api/ddragon/profile-icons", Handler: ddragonProfileIconsHandler, API: true},
		{Pattern: "/api/lcu/status", Handler: lcuStatusHandler, API: true},
		{Pattern: "/api/lcu/overview", Handler: lcuOverviewHandler, API: true},
		{Pattern: "/api/lcu/profile", Handler: lcuProfileHandler, API: true},
		{Pattern: "/api/lcu/profile-icons", Handler: lcuProfileIconMetadataHandler, API: true},
		{Pattern: "/api/lcu/profile-icons/owned", Handler: lcuOwnedProfileIconsHandler, API: true},
		{Pattern: "/api/lcu/launch-league", Handler: lcuLaunchLeagueHandler, API: true},
		{Pattern: "/api/lcu/match-history", Handler: lcuMatchHistoryHandler, API: true},
		{Pattern: "/api/lcu/game-detail", Handler: lcuGameDetailHandler, API: true},
		{Pattern: "/api/lcu/skins", Handler: lcuSkinsHandler, API: true},
		{Pattern: "/api/lcu/background-champions", Handler: lcuBackgroundChampionsHandler, API: true},
		{Pattern: "/api/lcu/background-skins", Handler: lcuBackgroundSkinsHandler, API: true},
		{Pattern: "/api/lcu/auto-accept", Handler: lcuAutoAcceptHandler, API: true},
		{Pattern: "/api/lcu/decline-ready", Handler: lcuDeclineReadyHandler, API: true},
		{Pattern: "/api/lcu/auto-requeue", Handler: lcuAutoRequeueHandler, API: true},
		{Pattern: "/api/lcu/stop-queue", Handler: lcuStopQueueHandler, API: true},
		{Pattern: "/api/lcu/quit-custom", Handler: lcuQuitCustomHandler, API: true},
		{Pattern: "/api/lcu/custom-start", Handler: lcuCustomStartHandler, API: true},
		{Pattern: "/api/lcu/available-queues", Handler: lcuAvailableQueuesHandler, API: true},
		{Pattern: "/api/lcu/create-lobby", Handler: lcuCreateLobbyHandler, API: true},
		{Pattern: "/api/lcu/lobby", Handler: lcuCurrentLobbyHandler, API: true},
		{Pattern: "/api/lcu/auto-roles", Handler: lcuAutoRolesHandler, API: true},
		{Pattern: "/api/lcu/loot", Handler: lcuLootHandler, API: true},
		{Pattern: "/api/lcu/wallet", Handler: lcuWalletHandler, API: true},
		{Pattern: "/api/lcu/loot/recipes", Handler: lcuLootRecipesHandler, API: true},
		{Pattern: "/api/lcu/loot/craft", Handler: lcuLootCraftHandler, API: true},
		{Pattern: "/api/lcu/dodge", Handler: lcuDodgeHandler, API: true},
		{Pattern: "/api/lcu/appear-offline", Handler: lcuAppearOfflineHandler, API: true},
		{Pattern: "/api/lcu/availability", Handler: lcuAvailabilityHandler, API: true},
		{Pattern: "/api/lcu/status-message", Handler: lcuStatusMessageHandler, API: true},
		{Pattern: "/api/lcu/profile-background", Handler: lcuProfileBackgroundHandler, API: true},
		{Pattern: "/api/lcu/profile-icon", Handler: lcuProfileIconHandler, API: true},
		{Pattern: "/api/lcu/honor-ballot", Handler: lcuHonorBallotHandler, API: true},
		{Pattern: "/api/lcu/honor-player", Handler: lcuHonorPlayerHandler, API: true},
		{Pattern: "/api/lcu/play-again", Handler: lcuPlayAgainHandler, API: true},
		{Pattern: "/api/lcu/claim-event-rewards", Handler: lcuClaimEventRewardsHandler, API: true},
		{Pattern: "/api/lcu/gameflow-phase", Handler: lcuGameflowPhaseHandler, API: true},
		{Pattern: "/api/lcu/champ-select", Handler: lcuChampSelectHandler, API: true},
		{Pattern: "/api/lcu/champ-select/pickable", Handler: lcuChampSelectPickableHandler, API: true},
		{Pattern: "/api/lcu/champ-select/bannable", Handler: lcuChampSelectBannableHandler, API: true},
		{Pattern: "/api/lcu/champ-select/skins", Handler: lcuChampSelectSkinsHandler, API: true},
		{Pattern: "/api/lcu/champ-select/action", Handler: lcuChampSelectActionHandler, API: true},
		{Pattern: "/api/lcu/champ-select/selection", Handler: lcuChampSelectSelectionHandler, API: true},
		{Pattern: "/api/lcu/champ-select/reroll", Handler: lcuChampSelectRerollHandler, API: true},
		{Pattern: "/api/lcu/champ-select/bench/swap", Handler: lcuChampSelectBenchSwapHandler, API: true},
		{Pattern: "/api/lcu/champ-select/runes", Handler: lcuChampSelectRunesHandler, API: true},
		{Pattern: "/api/lcu/champ-select/runes/catalog", Handler: lcuChampSelectRuneCatalogHandler, API: true},
		{Pattern: "/api/lcu/champ-select/runes/select", Handler: lcuChampSelectRuneSelectHandler, API: true},
		{Pattern: "/api/lcu/champ-select/runes/page", Handler: lcuChampSelectRunePageHandler, API: true},
		{Pattern: "/api/lcu/friends", Handler: lcuFriendsHandler, API: true},
		{Pattern: "/api/lcu/health", Handler: lcuHealthHandler, API: true},
		{Pattern: "/api/lcu/server-status", Handler: lcuServerStatusHandler, API: true},
		{Pattern: "/api/qol/queue-presets", Handler: qolQueuePresetsHandler, API: true},
		{Pattern: "/api/qol/preferences", Handler: qolPreferencesHandler, API: true},
		{Pattern: "/api/qol/state", Handler: qolStateHandler, API: true},
		{Pattern: "/api/diagnostics/reports", Handler: diagnosticsReportsHandler, API: true},
		{Pattern: "/lol-game-data/", Handler: lcuAssetProxyHandler},
	}
}

func registerDashboardRoutes(mux *http.ServeMux) {
	for _, route := range dashboardRoutes() {
		if route.API {
			mux.HandleFunc(route.Pattern, originCheck(route.Handler))
			continue
		}
		mux.HandleFunc(route.Pattern, route.Handler)
	}
}
