# RiftOps

RiftOps is a desktop hub for Riot games, with League presence controls and
local League Client quality-of-life tools. It runs on Windows today, with macOS
build support in the project.

## Start here

1. Download the latest `RiftOps-windows-amd64.exe` from the
   [GitHub Releases page](https://github.com/HassanSalah120/RiftOps/releases).
2. Put the file in a permanent folder, such as `C:\RiftOps`.
3. Start **RiftOps**, choose the game you want, then press **Launch**.
4. For League tools, open and sign in to the League Client first. In RiftOps,
   select **Quality of Life** from the sidebar.

There is no Riot password field in RiftOps. Riot Client handles your normal
sign-in and remembers your session as usual.

### macOS first launch

The GitHub build is ad-hoc signed but is not yet Apple-notarized. After
extracting `RiftOps-macOS.zip`, move `RiftOps.app` to Applications, then
Control-click the app and choose **Open** on first launch. If macOS still says
the app is damaged, remove the download quarantine in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/RiftOps.app
```

## What you can do

- Launch League, VALORANT, Runeterra, 2XKO, or Riot Client from one app.
- Set your League presence to online, offline, or mobile-style masking.
- View League account data, match history, and skin collection.
- Customize your League profile background with any champion skin.
- Accept a ready check, save lobby role preferences, dodge in champion select,
  play again after a match, and claim completed missions.
- Use tray controls, diagnostics, update checks, and Windows startup settings.

## League QoL quick guide

Open League first, then use RiftOps → **Quality of Life**.

| You want to… | In RiftOps |
|---|---|
| Change your profile background | Profile Customization → Champion → Skin → Apply Background |
| Appear offline | Social & Presence → Appear Offline |
| Save lane preferences | Queue & Lobby → choose roles → Save Roles |
| Accept a queue pop | Queue & Lobby → Accept Ready Check |
| Dodge | Champion Select → Dodge Game |
| Return to the lobby | End of Game → Play Again |

Controls become available only when League is in the right phase. If the
Champion dropdown does not load after League opens, choose **Retry loading
champions**.

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
