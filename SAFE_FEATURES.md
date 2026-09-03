# RiftOps Safe Feature Suite

This release implements the safe, local-only feature set from the competitor
review. RiftOps talks to the League Client Update (LCU) on loopback and uses
official Riot static data; it does not ship API keys, a hosted backend, DOM
injection, scraping, or third-party data ingestion.

## Available workspaces

- **Social Center** — grouped friends, search/status filters, request decisions,
  lobby invitations, and desktop-only reviewed bulk removal/invites (20 users,
  sequential, cancellable, typed confirmation).
- **Profile Studio** — complete Data Dragon icon catalogue, ownership badges,
  any-skin profile background, 255-character status editor, and account-scoped
  named presets with preview/apply and per-field results.
- **Play Flow → Preparation** — queue/role/lobby presets, rune and fallback
  rune references, client-provided custom bots, and explicit apply actions.
- **Match History** — local replay status, download, and confirmed Watch
  actions; no arbitrary player lookup.
- **Quality of Life → Safe utilities** — client settings snapshots (10 per
  account), preview/restore with rollback, pending reward selection, and
  redacted LCU capability diagnostics.

## Storage and safety

Feature data is stored atomically in `features.json` under RiftOps’ private
configuration directory. Account records use `SHA-256(PUUID)` keys. Passwords,
LCU credentials, access tokens, API keys, and external responses are never
stored. Destructive/bulk actions are desktop-only and require a fresh preview,
typed confirmation, per-target revalidation, and a redacted receipt.

Official Riot/client metadata is cached only in the browser/webview, under a
versioned key with a 20 MiB bound; stale entries naturally expire while the
current and previous patch can coexist.

The phone manifest explicitly allows only social control, preset apply, quick
lobby, and replay control. Item-set writes, settings, diagnostics, account
session management, backups/restore, rewards, bulk operations, and process
control remain desktop-only.

When an LCU route or response shape is unavailable, the UI reports
**Unavailable for this League patch** and does not guess or mutate through a
fallback route.

## Localization

English and Arabic are available in Settings. The selected locale is stored as
`riftops.locale`; Arabic sets document `dir="rtl"` and mirrors directional
controls using CSS logical properties.

## Verification

Run from the repository root:

```text
go test ./...
cd cmd/riftops-ui/frontend
npm test
npm run lint
npm run build
```

The final Windows/macOS artifact gates and live-client acceptance matrix are in
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
