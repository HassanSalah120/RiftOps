# Changelog

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
