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
| Enhanced dashboard and safe diagnostics | Not present | `cmd/riftops-ui/main.go`, `internal/diagnostics` | Implemented; native visual gate |
| Saved launch and presence preferences | Not present | `internal/settings`, dashboard settings | Verified persistence; no credential storage or account switching |
| League Client match, skins, and QoL tools | Not present | `internal/riotclient`, dashboard panels | Implemented; profile background uses the League `backgroundSkinId` preference endpoint with a Champion → any-skin picker. LCU response/error handling is covered by focused tests; live-client validation remains a release gate |
| Legacy preference migration | Legacy files in `%APPDATA%/Deceive` | `internal/settings/settings.go` | Verified with migration tests |
| Stream fragmentation/coalescing safety | Legacy string reads in `ProxiedConnection.cs` | `internal/xmpp` incremental framer | Verified with unit and fuzz tests |
| Windows distribution | `.csproj`/WinForms | Fyne package script and GitHub Actions | Release gate: sign and run clean-machine test |
| macOS distribution | Not supported | Darwin adapter, Fyne package script and GitHub Actions | Release gate: sign, notarize, and run clean-machine test |

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

## LCU QoL reliability update (v2.3.7)

- The dashboard exposes phase-aware ready-check acceptance, lobby role
  preferences, champion-select dodge, end-of-game Play Again, mission claims,
  social presence, and profile customization.
- Profile backgrounds use Champion → any Skin → Apply; they are not restricted
  to skins owned by the active account.
- A League lockfile is probed before use. Stale lockfiles are ignored, and on
  Windows RiftOps reads the live LeagueClientUx process arguments when needed.
- Request-path tests cover the profile background, dodge, role preference,
  mission claim, and live-LCU probe behavior. A current live League session is
  still needed for end-to-end validation.

1. Run an end-to-end Riot login/chat/game smoke test on a current Windows 11 machine.
2. Run the same smoke test on a supported macOS version and confirm Riot's actual app-bundle layout.
3. Exercise native tray, hide/show, restart, stop, update prompt, and multi-monitor behavior.
4. Run a long reconnect test covering Riot Client self-relaunch and chat disconnects.
5. Sign the Windows executable; sign and notarize the macOS app.
6. Run both artifacts on clean machines and confirm no undeclared runtime dependencies.
7. Publish a release candidate before replacing the legacy executable.
