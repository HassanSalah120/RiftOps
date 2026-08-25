# RiftOps

RiftOps is a desktop hub for Riot games, with League presence controls and
local League Client quality-of-life tools. Native downloads are available for
Windows and macOS. The canonical release version is stored in the root
`VERSION` file; the local packaging scripts read it when `-Version`/the version
argument is omitted.

## Start here

1. Download the latest `RiftOps-<version>-win-x64.exe` from the
   [GitHub Releases page](https://github.com/HassanSalah120/RiftOps/releases).
2. Put the file in a permanent folder, such as `C:\RiftOps`.
3. Start **RiftOps**, choose the game you want, then press **Launch**.
4. For League tools, open and sign in to the League Client first. In RiftOps,
   select **Quality of Life** from the sidebar.

Windows release trust: the v2.7.2 binary predates the Kingof30 Authenticode
signing pipeline and may show a SmartScreen “Unknown publisher” prompt. Verify
the downloaded file against its `.sha256` checksum before running it. The
release workflow now refuses to publish future Windows binaries unless they
are signed with the configured Kingof30 certificate and timestamped.

League does not have to be inside the Riot Client folder. On Windows, RiftOps
also reads Riot's install registry and checks the registered League folder
directly, including custom drives such as `D:\Games\League of Legends`. If a
friend's PC still shows **Client unavailable**, update to the latest release,
start League and sign in once, then use the refresh button in the RiftOps
health card; do not copy or share the League `lockfile` because it contains a
temporary local credential.

On macOS, RiftOps checks both `/Applications/League of Legends.app` and
`~/Applications`. If League is installed elsewhere, open **Settings → Riot
Client location**, then use **Browse**, **Auto-detect**, or paste the `.app`
path. RiftOps validates the selection and stores the resolved executable in
`settings.json`.

There is no Riot password field in RiftOps. Riot Client handles your normal
sign-in and remembers your session as usual.

RiftOps does not currently provide a cross-platform account/session switcher.
The saved-session vault is Windows-only and protected by Windows DPAPI; macOS
does not persist Riot credentials or session tokens. On every platform, normal
authentication remains owned by Riot Client.

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
- View your live summoner identity and rank in Command Center, plus match
  history and skin collection.
- Customize your League profile background with any champion skin and browse
  your owned profile icons from Collection → Profile Studio.
- Automatically accept ready checks or return to the lobby after a match.
- Start or stop matchmaking, save lane preferences, and dodge during champion
  select with a clear safety confirmation.
- Browse profile icons visually, use any champion skin as your background,
  honor players, and claim available event-track rewards.
- Use the League Client quick-action bar for launch, accept, queue, stop, and
  Play Again actions with phase-aware disabled states.
- Control a live Champion Select workspace: inspect timer, team, opponent,
  pick/ban actions, lock-in state, and the full ban board.
- Request, accept, decline, or cancel supported teammate pick-order and role
  swaps directly from Champion Select (League exposes these only in compatible
  queues and phases).
- Search the LCU's pickable and bannable champions, hover a choice, lock it in,
  choose owned skins and summoner spells, switch rune pages, and use ARAM
  rerolls or bench swaps when League exposes them.
- Configure Play Flow draft policies: act immediately, after a delay, or in the
  last seconds; apply a selected rune page before picking; and automatically
  fall back when a pick or ban is already occupied by the draft.
- In Arena, optionally choose League's Bravery special pick (`-3`) instead of
  sending a normal champion ID; the option is guarded so it cannot be used for
  bans or non-Arena queues.
- Arena Champion Select also surfaces the live LCU choice pool (including
  Crowd Favorites when League publishes it), resolves Bravery into the actual
  champion before skin selection, and keeps the post-resolution skin step
  explicit instead of guessing a champion.
- Keep local six-item reference plans for both the primary and fallback pick;
  RiftOps uses them as a planning aid and does not silently mutate League's
  item inventory.
- Follow one canonical **Live Session** page from queue and ready check through
  Champion Select, loading, active game, reconnecting, and immediate post-game.
- When a match is running, Live Session can read the documented League Game
  Client Data API for live players, KDA/CS, items, active-player stats, game
  time, and objective events. This is read-only; RiftOps never injects input
  into the game client.
- Arena Live Session and Match History show event, round, teams remaining,
  placement, fame, partner, and augment fields when the current League payload
  exposes them. Missing Arena fields remain labelled unavailable rather than
  being inferred by RiftOps.
- Search and filter a reconnecting League friend list from the Social area.
- Use Loot Workshop for live resource balances, League-backed crafting
  recipes, explicit reroll/disenchant/open/upgrade labels when League exposes
  them, and recent inventory changes.
- If LCU match history is unavailable and public Riot API authentication is
  configured, Match History can fall back to Match-V5 data. Set the optional
  `riftops.riot.region` local preference to your platform code when needed.
- Open the command palette with `Ctrl+K` (Windows) or `Cmd+K` (macOS), or use
  `Alt+1` through `Alt+9` to switch desktop workspaces.
- Use tray controls, diagnostics, update checks, and Windows startup settings.
- Scan the Phone control QR code to open a paired, mobile-friendly RiftOps
  dashboard from any phone on the same Wi-Fi network (opt-in, see below).

## Phone control (Mimic-style)

RiftOps includes a LAN-first phone mode inspired by Mimic. It does not send
League data through a RiftOps relay server: the desktop keeps the LCU connection
and the phone talks directly to the desktop over the local network.

1. Start RiftOps and open **Remote Access** under System.
2. Turn on phone control with the **Turn on** button in the Phone control card
   (it stays off until you enable it, including after restarting RiftOps).
3. Make sure the phone and computer are on the same Wi-Fi network.
4. Scan the **Phone control** QR code with the phone camera.
5. Keep the resulting page open for the phone-safe League workflow: current
   client state, lobby and queue controls, ready check, friends, reversible LCU
   presence, Champion Select, existing rune-page selection, match history, and
   a read-only skin catalogue and the read-only Active Game dashboard. Phone
   permissions are enforced by the server, not only hidden in the interface.

Desktop settings, saved-login/profile data, Riot Client paths, update checks,
autostart, automation-policy editing, loot and crafting, rune-page editing,
profile cosmetics, diagnostics, RiftOps engine start/stop, and app quit are not
available to paired phones. Launching the League Client itself remains a named
phone capability so an authenticated device can reconnect the local client;
it does not expose a process command or filesystem path.

Each pairing QR expires after five minutes and is invalid immediately after one
phone uses it. The phone receives a separate in-memory session that lasts up to
eight hours. The desktop card lists active devices and can disconnect one or all
of them without replacing every QR. Sessions are also revoked when RiftOps
exits. The mobile listener uses a separate LAN port; if Windows Firewall asks,
allow RiftOps on private networks only. Pairing traffic is plain HTTP on your
local network, so use only your own devices on trusted private Wi-Fi and never
expose the listener to the internet.

The mobile dashboard loads League artwork from Riot Data Dragon and the local
CommunityDragon fallback catalogue. The phone therefore needs normal internet
access for those external images; the RiftOps API itself remains on the local
LAN listener.

The Live Session scoreboard uses Riot's documented Game Client Data API on the
local game client port (2999). It may be temporarily unavailable during loading,
reconnect, or when League has not started its game data service; RiftOps keeps
the last phase visible and does not invent missing statistics.

## League QoL quick guide

Open League first, then use RiftOps → **Quality of Life** for client utilities,
**Collection** for skins and profile identity, or **Loot Workshop** for
inventory and crafting.

| You want to… | In RiftOps |
|---|---|
| Change your profile background | Collection → Profile Studio → Champion → Skin → Apply |
| Browse profile icons | Collection → Profile Studio → search an owned icon → select → Apply |
| Inspect or run a loot recipe | Loot Workshop → choose a material → Recipe Inspector |
| Change presence or bio | Social → choose presence or update status message |
| Save lane preferences | Queue Command → choose roles → Save Roles |
| Automatically accept queue pops | Automation → Auto-accept ready checks |
| Start or stop matchmaking | Queue Command → Start Queue / Stop Queue |
| Dodge | Champion Select → Dodge Game → confirm |
| Return to the lobby | Post Game → Play Again |
| Claim event rewards | Post Game → Claim Event Rewards |

| View and control Champion Select | Champion Select → Live Client Control |
| Pick or ban a champion | Champion Select → search → choose → Lock in |
| Change spells, skin, or runes | Champion Select → Loadout |
| Use ARAM reroll/bench | Champion Select → ARAM Bench |
| Find a friend | Social → Friends → Search friends |
| Run a common client action | Dashboard → Quick actions |

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
- Purpose-based workspaces grouped as **Operate**, **Review**, and **System**,
  with one primary action and nearby feedback for each workflow
- Command Center summoner/rank overview, phase-aware Play Flow, canonical Live
  Session, match history, Collection, and action-first Loot Workshop
- League friend list, client health/server status, dedicated Remote Access,
  settings, diagnostics, keyboard command palette, and release update checks

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for feature evidence and
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for the public-release gates.

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
./scripts/build-windows.ps1 -Build 1
```

```sh
bash ./scripts/build-macos.sh
```

Outputs are `dist/RiftOps-<version>-win-x64.exe` and
`dist/RiftOps-macOS.zip`, each with a matching `.sha256` checksum. The Windows
and macOS release workflows run the same locked frontend install, lint, tests,
production build, race-enabled desktop Go tests, and vet gates. Public releases
still require platform signing and macOS Developer ID notarization.

If Windows reports that the standard executable is in use, close RiftOps and
build again. The script safely writes a versioned fallback such as
`dist/RiftOps-<version>-win-x64-copy.exe` instead of replacing a running file.

The desktop dashboard prefers loopback port `24080`. If another local service
or a Windows excluded-port policy blocks it, RiftOps tries `24081` through
`24089`, then asks Windows for a free loopback port automatically. The selected
port is remembered for the single-instance “show RiftOps” action and is removed
when the app exits.

## League Quality of Life controls

League must be open before using these local-client controls. RiftOps detects
the active League Client API and ignores stale lockfiles left after a prior
League session.

- **Automation:** persistent auto-accept and auto-return-to-lobby options work
  while RiftOps is running, even if the QoL page is closed.
- **Social:** use live Online, Away, Mobile, or Offline presence and update the
  chat status message.
- **Profile cosmetics:** use Collection → Profile Studio to select any champion
  skin as a background and search the owned visual profile-icon library.
- **Queue & Lobby:** accept a ready check, start or stop matchmaking, and save
  validated primary/secondary role preferences from a lobby.
- **Champion Select:** pick, ban, and lock champions through the LCU action
  queue; change spells, owned skin, and rune page; use ARAM rerolls/bench
  swaps; configure timing, safe fallback picks/bans, and Arena Bravery; and
  dodge only during champion select.
- **End of Game:** return to the lobby, submit an honor vote, and claim
  available event-track rewards using current League Client routes.

Buttons are disabled outside their valid League phase. If profile data was
requested before League finished connecting, use **Retry loading champions**.

## Ownership and compatibility

The Go module and release updater use <https://github.com/HassanSalah120/RiftOps>.
RiftOps stores data under the `RiftOps` user configuration directory and imports
compatible settings from the previous `Deceive` directory on first launch.

RiftOps rewrites Riot chat to `127.0.0.1` and generates a private local
certificate for the chat proxy. The rewritten client configuration enables
Riot's local bad-certificate compatibility mode, so RiftOps no longer depends
on a predecessor-owned DNS record or remote certificate download service.

RiftOps does not expose account switching or store Riot credentials in its
dashboard. It keeps normal launch and presence preferences locally, while Riot
Client remains responsible for authentication and remembered-login behavior.

League-only panels use the locally running League Client API. They require the
League Client to be open, and actions such as dodge, play again, reward claims,
or profile customization are sent only when the local client confirms success.

## Crash and hang reports

On Windows, RiftOps keeps its diagnostic files here:

- `%LOCALAPPDATA%\riftops\debug.log` — the current bounded application log;
  the previous segment is retained as `debug.log.1`.
- `%LOCALAPPDATA%\riftops\reports\` — timestamped panic, hang, unexpected-exit,
  and unclean-exit reports.

An `unclean-exit` report is created on the next launch when the previous process
ended before RiftOps could run its normal shutdown path. Reports contain runtime
state and goroutine stacks. They are scrubbed for authorization values, pairing
and session tokens, query secrets, and local home paths; stored with private
permissions where the platform supports Unix modes; and limited to the newest
20 reports with a 30-day maximum age.

## Safety boundary

The main dashboard and Riot proxies bind only to loopback. Optional Phone
control binds a separate private-LAN listener, consumes a short-lived one-time
pairing token, creates expiring/revocable in-memory device sessions, and exposes
only an explicit, named mobile capability manifest. A route inventory test
ensures phone permissions cannot reference an unregistered endpoint, and new
desktop APIs remain remote-denied by default. The config proxy forwards only
Riot's required headers, the outgoing chat connection verifies Riot's TLS
hostname, RiftOps-generated certificates are cached with hostname/validity
checks, and diagnostics exclude tokens and chat content.
