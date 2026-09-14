# Changelog

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
