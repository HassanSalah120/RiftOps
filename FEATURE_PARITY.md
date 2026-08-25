# Feature parity and release evidence

Status meanings:

- **Verified**: covered by automated tests or a successful cross-build.
- **Implemented**: code-complete, but requires a live Riot/native OS validation.
- **Release gate**: required before publishing binaries.

| Capability | Legacy evidence | Rebuild evidence | Status |
|---|---|---|---|
| Game prompt and remembered default | `GamePromptForm.cs`, `Persistence.cs` | `cmd/riftops-ui/main.go`, `internal/settings` | Verified |
| League, VALORANT, Runeterra, 2XKO, Riot Client launch | `StartupHandler.cs` | `internal/model`, `internal/platform/platform.go` | Verified argument generation; live launch gate |
| Detect/restart existing Riot processes | `Utils.cs` | `internal/platform/platform_windows.go`, `platform_darwin.go`, `internal/engine` | Implemented on both OSes |
| Prevent duplicate RiftOps instances | `Utils.cs` process scan | `internal/singleinstance` | Verified on Windows; Darwin cross-build verified |
| Riot client-config proxy | `ConfigProxy.cs` | `internal/configproxy` | Verified with HTTP and rewrite tests |
| Affinity/PAS chat selection | `ConfigProxy.cs` | `internal/configproxy/rewrite.go`, `server.go` | Verified with unit tests |
| Local TLS chat proxy | `MainController.cs` | `internal/chatproxy/proxy.go` | Implemented; live handshake gate |
| Online/offline/mobile masking | `ProxiedConnection.cs` | `internal/presence` | Verified with stanza fixtures |
| Lobby and champion-select chat option | `MainController.cs` | `internal/presence`, dashboard and tray | Verified transformation behavior |
| Fake RiftOps friend and chat commands | `ProxiedConnection.cs`, `MainController.cs` | `internal/fakeplayer`, `internal/chatproxy` | Verified with roster/command tests |
| First-run chat guidance | `MainController.cs` | `internal/engine/engine.go` | Implemented |
| Remember-last/default startup status | `MainController.cs`, `Persistence.cs` | `internal/settings`, dashboard and tray | Verified persistence |
| Certificate download/cache | `Utils.cs`, `Persistence.cs` | `internal/certificate` | Implemented with stronger hostname and validity checks |
| Update notification | `Utils.cs` | `internal/update`, dashboard lifecycle | Version logic verified; live UI gate |
| Extra Riot/game arguments | `StartupHandler.cs` | `cmd/riftops/main.go`, `internal/platform` | Verified argument generation |
| System tray workflow | `MainController.cs` | `cmd/riftops-ui/main.go` | Implemented for Windows/macOS |
| Enhanced dashboard and safe diagnostics | Not present | `cmd/riftops-ui/main.go`, `internal/diagnostics` | Implemented with redaction, private files, rotation, and report retention; native visual gate |
| Saved launch and presence preferences | Not present | `internal/settings`, dashboard settings | Verified persistence; no credential storage or account switching |
| League Client match, skins, loot, and QoL tools | Not present | `internal/riotclient`, purpose-based frontend workspaces | Implemented; account identity is consolidated in Command Center, Collection contains the Skin Library and Profile Studio, Loot Workshop owns live wallet/recipe workflows, and QoL stays utility-focused. LCU response/error handling is covered by focused tests; live-client validation remains a release gate |
| Mimic-style Champion Select controls | Archived Mimic `web/src/components/champ-select` | `internal/riotclient/lcu.go`, `cmd/riftops-ui/main.go`, `ChampSelectWorkspace.tsx` | Implemented: timer, team/opponent state, ban board, pick/ban search, lock-in, spells, owned skin, rune-page selection, ARAM reroll/bench actions, and LCU-backed pick-order/role swap request flow; live-client validation remains a release gate |
| Play Flow draft policy | RiftOps extension | `PlayFlowPage.tsx`, `champSelectFlow.ts`, `arenaBravery.ts` | Implemented: immediate/after-delay/last-second timing, pick rune-page preflight, conflict-aware primary/fallback pick and ban candidates, Arena-only Bravery special pick, and server-confirmed retries |
| Arena event and progress layer | Riot Arena event/champ-select systems plus local Game Client Data | `arenaTelemetry.ts`, `ChampSelectWorkspace.tsx`, `LiveSessionPage.tsx`, `MatchHistory.tsx` | Implemented: Arena event labels, League-provided choice-pool messaging/Crowd Favorites path, Bravery post-resolution skin handoff, live round/teams/placement/fame/partner/augment fields when exposed, and Arena history summaries with honest unavailable states |
| Unified Live Session | RiftOps extension | `LiveSessionPage.tsx`, `liveSession.ts`, LCU overview/gameflow session | Implemented: one phase-driven page for queue, ready check, Champion Select, loading, active game, reconnecting, and post-game; live payload fields remain availability-aware |
| Active Game read-only dashboard | Riot Game Client Data API | `internal/riotclient/gameclient.go`, `LiveSessionPage.tsx`, LCU overview | Implemented: local Game Client API snapshot for game time, active player, teams, KDA/CS, items, and recent events; live game validation remains a release gate |
| Match-V5 analytics fallback | Riot public Match-V5 API | `internal/riotapi/api.go`, Riot API routes, `MatchHistory.tsx` | Implemented as an opt-in fallback when LCU history fails and public Riot authentication is configured; API key/rate-limit and live-account validation remain release gates |
| Local build planning | RiftOps extension | `BuildPlanner.tsx`, `buildPlanner.ts`, Play Flow | Implemented: six-item primary/fallback references persisted locally; no undocumented LCU item-set mutation |
| Legacy preference migration | Legacy files in `%APPDATA%/Deceive` | `internal/settings/settings.go` | Verified with migration tests |
| Stream fragmentation/coalescing safety | Legacy string reads in `ProxiedConnection.cs` | `internal/xmpp` incremental framer | Verified with unit and fuzz tests |
| Windows distribution | `.csproj`/WinForms | Fyne package script and GitHub Actions | Release gate: sign and run clean-machine test |
| macOS distribution | Not supported | Darwin adapter, Fyne package script and GitHub Actions | Release gate: sign, notarize, and run clean-machine test |
| Mimic-style phone control | Archived Mimic conduit/web/relay | `cmd/riftops-ui/remote_access.go`, named phone capabilities, mobile-responsive live workspaces, and dedicated Remote Access administration | Implemented for trusted LAN use; server-enforced permissions exclude desktop settings, sessions, automation editing, loot/crafting, rune CRUD, cosmetics, pairing administration, diagnostics, and filesystem controls. Live phone and firewall validation remains a release gate |

## Intentional improvements

- The app stays available after Riot exits instead of terminating, so another
  game can be launched without reopening RiftOps.
- XML is framed incrementally instead of assuming each socket read contains a
  complete stanza.
- Outgoing Riot TLS certificates are always verified; the legacy fallback that
  disabled certificate validation is not carried forward.
- Settings are stored atomically in one versioned JSON file and legacy settings
  are migrated once.
- Errors and connection phases are visible in a dashboard instead of only tray
  balloons or modal dialogs.

## Release gates

## LCU QoL reliability update

- The dashboard exposes live client state, persistent auto-accept and
  auto-return, queue start/stop, lobby role preferences, champion-select dodge,
  post-game honor, event reward claims, social presence, and profile
  customization.
- Profile backgrounds in Collection → Profile Studio use Champion → any Skin → Apply; they
  are not restricted to skins owned by the active account.
- A League lockfile is probed before use. Stale lockfiles are ignored, and on
  Windows RiftOps reads the live LeagueClientUx process arguments when needed.
- Current Swagger evidence confirms the ready-check, queue, dual role
  preference, dodge, Play Again, honor, chat, profile, and event-reward routes.
  The removed mission POST route was replaced with the current event reward
  claim-all flow.
- Request-path tests cover wallet fallback, loot recipe discovery/crafting,
  profile background, dodge, role preference fallback, honor payload, event
  reward claim, QoL state, and live-LCU probe behavior. A current live League
  session is still needed for end-to-end validation.

1. Run an end-to-end Riot login/chat/game smoke test on a current Windows 11 machine.
2. Run the same smoke test on a supported macOS version and confirm Riot's actual app-bundle layout.
3. Exercise native tray, hide/show, restart, stop, update prompt, and multi-monitor behavior.
4. Run a long reconnect test covering Riot Client self-relaunch and chat disconnects.
5. Sign the Windows executable; sign and notarize the macOS app.
6. Run both artifacts on clean machines and confirm no undeclared runtime dependencies.
7. Publish a release candidate before replacing the legacy executable.
