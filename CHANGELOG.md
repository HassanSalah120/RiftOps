# Changelog

## v2.10.20 — 2026-10-15

- Stopped reporting successful Offline masking through native Riot chat. Offline requires the secure chat proxy; native mode now rejects the request before writing League availability.
- Disabled Offline controls when a connected client has no masking proxy and added recovery guidance for relaunching with the published Windows build.
- Corrected the Home launch card and workspace header to distinguish native chat, proxy startup, and an active proxy.
- Kept the selected masked Offline status visible even when League's local availability reports Online, and normalized native Online selection.
- Added regression tests for false native Offline success and the distinction between local availability and outgoing masked presence.
- Windows release packaging includes the validated trusted chat certificate; local development previews are not a replacement for that release when using Offline masking.

## v2.10.19 — 2026-10-14

- Added Solo/Duo and Flex rank, division, LP, and last-checked date to Riot account rows. Verified ranks refresh while League is connected and remain available after switching or closing League.
- Kept rank caches separate by account and server, preserved previous data on failed or interrupted reads, and supported League's queue-map rank format. Accounts without loaded data are distinct from confirmed unranked accounts.
- Preserved newer native Riot sessions during ordinary launches instead of replaying old saves. Explicit account switching remains the path that restores saved logins.
- Requested graceful Riot shutdown before saving settled login files during Stop and switching. Same-account switches now use the completed save's current readiness.
- Preserved only the intended account's valid remembered-device cookie during fresh sign-in, while clearing authorization. RiftOps's local retention does not extend Riot's authentication or device-trust expiry.
- Detected incomplete remembered-login snapshots and added a confirmed Close Riot & save recovery action. Saving cannot silently overwrite a complete login with an incomplete snapshot.
- Recognized authenticated PendingProductContext sessions using a separate live RSO check, while rejecting pending MFA and account changes. Chat fallback waits for sign-in to finish before restarting Riot.
- Serialized account lifecycle operations and vault mutations, kept status reads consistent during save replacement, and stopped profile selection when shutdown fails.
- Updated the GitHub Pages release showcase with the account rank display and remembered-login changes.

## v2.10.18 — 2026-10-12

- Replaced the Collection gallery with champion portraits and completion rings: gold for owned skins, green for distinct shard-only skins, and a dark track for missing skins.
- Joined account ownership with the full skin catalogue so unowned champions remain visible and completion totals stay accurate. Duplicate shards and temporary rentals do not count as permanent ownership.
- Added champion search, completion filters, expandable advanced filters, and an inline skin browser with keyboard focus restoration.
- Added optional first-launch setup for preferred game, launch presence, and background activity. Saving or skipping opens Home; returning users keep their existing workspace and preferences.
- Kept setup recoverable after interrupted or failed saves, and prevented unloaded preferences from being overwritten. Phone access bypasses desktop setup.
- Updated the GitHub Pages showcase and downloads with the new Collection design, first-launch setup, and portable Windows download.
- Corrected macOS download labels to Apple Silicon (ARM64), matching the architecture in the packaged archive.
- Updated the CSS parser and source-map build dependencies to patched versions; the frontend dependency audit reports no known vulnerabilities.

## v2.10.17 — 2026-10-11

- Reworked every dashboard workspace with clearer actions, aligned controls, responsive navigation, and improved loading, empty, and error states.
- Improved keyboard access and dialog focus, notification alignment, settings navigation, and mobile layouts.
- Prevented duplicate reviewed operations and added status checks and retry feedback for interrupted actions.
- Refreshed verified saved Riot sessions when switching accounts while preserving their original retention deadline. Existing affected accounts should be saved again after signing in with Stay signed in enabled.
- Kept fresh sign-in on native Riot chat and prevented the chat handshake timer from restarting Riot while credentials are being entered.
- Blocked overlapping account changes and launches. Thirty days remains a local retention limit; Riot can require authentication sooner.
- Enabled macOS packaging on version tags alongside Windows packaging. macOS archives use ad-hoc signing and are not notarized.

## v2.10.5 — 2026-09-15

- Fixed one-click League launch against Riot Client's current product-launcher endpoint.
- Added Riot's direct-launch flag to normal and fallback startup paths.
- Kept the trusted presence proxy active while League finishes opening.

## v2.10.4 — 2026-09-15

- Kept the runtime status active when League refreshes its chat configuration after RiftOps has already established the trusted proxy session.

## v2.10.3 — 2026-09-15

- Fixed Windows release packaging so presence masking ships with a publicly trusted DuckDNS certificate instead of silently falling back to an untrusted local certificate.
- Windows release builds now fail unless the certificate is trusted, matches the RiftOps proxy hostname, is embedded successfully, and the hostname resolves to loopback.
- Certificate provisioning now keeps DuckDNS TXT cleanup separate from address updates and points the dedicated proxy hostname to `127.0.0.1`.

## v2.10.2 — 2026-09-15

### Install-only trusted chat release path

- Added a Deceive-style release option that bundles one validated trusted
  proxy certificate and fixed DuckDNS hostname, so end users do not enter a
  DuckDNS token.
- Added build-time PFX validation and cleanup; certificate material is never
  committed or logged.
- Added bundled-proxy status reporting and hid per-user setup controls in
  bundled releases.

## v2.10.1 — 2026-09-15

### Riot Client chat and launch compatibility

- Reuse an already-open Riot Client with native friends and chat instead of returning the old “Riot Client is already running” preflight error.
- Launch League through the existing Riot Client LCU when the client is already open.
- Keep the clean-start requirement for other game launches that need product-specific launch arguments.
- Add a bounded 30-second chat-proxy handshake timeout that restores native Riot chat when the local proxy is not accepted.

## v2.10.0 — 2026-09-15

This release consolidates the current RiftOps work into a safer, more informative League operations deck.

### Draft and queue safety

- Added role-aware primary/fallback pick and rune plans for Top, Jungle, Mid, Bot, and Support.
- Fill and unresolved lane assignments now wait instead of guessing a champion.
- Manual League hovers pause automation for the current turn and resume on the next action.
- Added bounded candidate checks, stale-session resets, rune-failure warnings, and independent manual queue / Full Auto controls.
- Added matchmaking diagnostics and leaver-restriction visibility with safe stop behavior.

### LCU feature expansion

- Added capability-gated champion swaps and ongoing swap state.
- Added spectator preparation, custom-game directory/invitations, chat privacy, and persistent mute controls.
- Added typed progress adapters for missions, rewards, mastery, scouting, and League loadouts.
- Added reviewed-operation safeguards for reward selection, invitations, custom sessions, chat mutes, and loadout changes.
- Sensitive League fields remain redacted and are never returned to the UI or written to logs.

### UI and catalog quality

- Added a shared League catalog resolver for champion and skin names, icons, and artwork fallbacks.
- Progress now displays readable champion names and detailed reward contents instead of raw IDs.
- Loot, Champion Select, Play & Queue, and Progress share the same catalog and session cache.
- Updated the public site and README to document the expanded workspaces and safety model.

### Verification

- Frontend lint, tests, and production build pass.
- Windows desktop build, race tests, vet, resource generation, and PE/GUI validation pass.
