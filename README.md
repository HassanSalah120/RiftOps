# RiftOps desktop application

This directory contains the maintained Go implementation of RiftOps for Windows
and macOS. The core Riot/XMPP protocol handling is separated from the native
Fyne dashboard and tray interface so stream transformations remain testable.

## Implemented

- Riot Client discovery, launch, restart, and process monitoring
- Loopback client-config and TLS chat proxies with affinity-aware routing
- Incremental XMPP framing and online/offline/mobile presence masking
- Lobby/MUC behavior and an in-game RiftOps control contact with notifications
- Game selection for League, VALORANT, Runeterra, 2XKO, and Riot Client
- Versioned local preferences and migration from earlier installations
- Saved launch, presence, and desktop-startup preferences
- League Client panels for Riot account data, match history, skin collection, and phase-aware Quality of Life actions
- Branded multi-page command center with dashboard, settings, system tray, diagnostics, and release update checks

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for verification evidence and release
gates.

## Development

The headless core builds without a C compiler:

```sh
go test ./...
go vet ./...
go run ./cmd/riftops --help
```

The native desktop application uses Fyne and CGO. Windows requires MinGW-w64;
macOS requires Xcode command-line tools. Install the packaging CLI with:

```sh
go install fyne.io/tools/cmd/fyne@v1.7.2
```

Build a native package:

```powershell
./scripts/build-windows.ps1 -Version 2.3.7 -Build 1
```

```sh
bash ./scripts/build-macos.sh 2.3.7 1
```

Outputs are `dist/RiftOps-windows-amd64.exe` and
`dist/RiftOps-macOS.zip`. Public releases still require platform signing and
macOS notarization.

If Windows reports that the standard executable is in use, close RiftOps and
build again. The script safely writes a versioned fallback such as
`dist/RiftOps-windows-amd64-v2.3.7.exe` instead of replacing a running file.

## League Quality of Life controls

League must be open before using these local-client controls. RiftOps detects
the active League Client API and ignores stale lockfiles left after a prior
League session.

- **Social:** appear online/offline and update the chat status message.
- **Profile:** select a champion, choose any of its skins as a profile
  background, and set a profile icon ID.
- **Queue & Lobby:** accept an active ready check and save primary/secondary
  role preferences from a lobby.
- **Champion Select:** dodge only during champion select.
- **End of Game:** return to the lobby with Play Again only at end of game.
- **Missions:** claim each completed mission through the local League client.

Buttons are disabled outside their valid League phase. If profile data was
requested before League finished connecting, use **Retry loading champions**.

## Ownership and compatibility

The Go module and release updater use <https://github.com/HassanSalah120/RiftOps>.
RiftOps stores data under the `RiftOps` user configuration directory and imports
compatible settings from the previous `Deceive` directory on first launch.

The current TLS compatibility defaults still use the predecessor's loopback DNS
and certificate endpoint. They are isolated as build-time variables in
`internal/engine` and must remain until a RiftOps-owned domain resolves to
`127.0.0.1` and provides a trusted matching certificate.

RiftOps does not expose account switching or store Riot credentials in its
dashboard. It keeps normal launch and presence preferences locally, while Riot
Client remains responsible for authentication and remembered-login behavior.

League-only panels use the locally running League Client API. They require the
League Client to be open, and actions such as dodge, play again, mission claim,
or profile customization are sent only when the local client confirms success.

## Safety boundary

Both local servers bind only to loopback. The config proxy forwards only Riot's
required headers, the outgoing chat connection verifies Riot's TLS hostname,
downloaded certificates are hostname/validity checked, and diagnostics exclude
tokens and chat content.
