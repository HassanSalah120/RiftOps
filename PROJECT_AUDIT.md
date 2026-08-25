# RiftOps whole-project audit

**Audit date:** 2026-08-25
**Scope:** Go desktop host and League integrations, embedded React UI, LAN phone control, packaging/release automation, tests, diagnostics, and documentation.
**Confidence:** High for source/config/test findings; medium for runtime behavior. A live League Client, firewall, clean-machine, and browser smoke test was not performed. The local Browser Use URL was intentionally not opened.

> **Current-status addendum (2026-08-25).** The findings and checklist below preserve
> the original audit evidence, but several entries are historical because the
> source has moved on. The current baseline is v2.7.1: custom League install
> discovery and Riot Client product launch are implemented, both platform release
> workflows run the same frontend and desktop Go gates, and the local verification
> suite passes (`npm run lint`, 30 frontend tests, production build,
> `go test -race -tags desktop ./...`, and `go vet -tags desktop ./...`). A new
> pull-request CI workflow runs those checks on Windows and macOS. The canonical
> release version is kept in `VERSION`, and packaging scripts use it when no
> version is supplied.
>
> The remaining release gates are not solved by splitting the oversized modules:
> live League/phone/firewall/clean-machine smoke tests, Developer ID signing and
> notarization, and ownership of the inherited Deceive-compatible TLS hostname and
> certificate. The LAN phone transport remains explicitly HTTP and trusted-LAN
> only. Saved session vaults use Windows DPAPI; macOS does not advertise account
> switching until a native Keychain implementation is added. These are explicit
> product/release constraints, not hidden failures.

The operator-facing release procedure is maintained in
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

## Remediation status — 2026-08-23

The source-addressable release blockers from this audit have now been implemented:

- The paired-phone server uses named, deny-by-default capability groups and returns an explicit `desktop`/`phone` capability bootstrap. A shared route inventory and contract tests prevent remote policy drift.
- The React app resolves the device capability before rendering, removes desktop-only navigation and commands, and supplies phone-specific live, presence, friends, and read-only collection behavior.
- Settings/profile snapshots are deep-cloned under the engine lock; the race-enabled desktop suite is clean.
- LCU calls are loopback-only, response and error bodies are bounded, query data and secrets are removed from errors, and related regression tests are present.
- Diagnostics now redact sensitive values and local home paths, use private modes where supported, rotate the debug log, and retain at most 20 reports for 30 days.
- Windows and macOS release workflows now use locked frontend installs, lint/test/build, race-enabled desktop Go tests, vet, platform packaging, and SHA-256 artifacts.
- The LCU overview provider remains the shared high-frequency state source. Specialized polling is limited to endpoint-specific data such as active Champion Select, expanded friends, or Riot service health rather than duplicating overview calls.

The remaining gates are environment-owned validation, not missing implementation: a real phone/firewall flow, a live League lobby-to-post-game smoke test, clean Windows/macOS startup, platform signing/notarization, and responsive visual browser checks. The prohibited local Browser Use URL was not opened.

## Executive decision (historical baseline; see current-status addendum above)

RiftOps has a solid desktop foundation and a credible LAN pairing design, but it is **not release-ready as a full phone companion yet**. The phone boundary is now enforced by the named, deny-by-default capability manifest in `remote_access.go`; the remaining blockers are live device/firewall validation, platform packaging, and a complete game smoke test.

The next release should ship only after these gates are closed:

1. Enforce a server-side mobile capability profile; CSS-hidden navigation is not authorization.
2. Fix the settings/profile data race found by `go test -race`. **Completed; retain the race gate.**
3. Add Windows CI/release packaging and make macOS CI run the same `desktop`-tagged tests. **Completed in the current baseline; retain as a regression gate.**
4. Add route-contract, remote-UI, responsive-layout, and clean-machine smoke coverage.
5. Consolidate LCU state into one query/event store instead of independent polling from every panel.
6. Publish the phone security limitation clearly: LAN HTTP is not encrypted and must never be exposed to the internet.

## 1. System map

| Layer | Current implementation | Assessment |
|---|---|---|
| Desktop shell | Fyne native host with a local HTTP server and embedded React/Vite assets | Good cross-platform shape; Windows WebView2 and macOS WebKit need separate runtime validation. |
| Core engine | `internal/engine`, settings/profile persistence, launch and presence state | Broad feature coverage; settings writes are serialized and race-tested. |
| League integration | `internal/riotclient` discovers the local lockfile and calls the LCU over loopback HTTPS; `internal/riotapi` handles Data Dragon/catalogue data | Correct trust model for a local client; response-size/error handling needs hardening. |
| Presence/chat | `internal/presence`, `internal/chatproxy`, `internal/configproxy`, XMPP framing | Useful differentiator; must stay isolated from remote phone permissions. |
| Desktop UI | `cmd/riftops-ui/frontend/src`, shared `App.tsx`, pages for command center, play flow, live session, history, skins, loot, QoL, settings | Feature-rich but duplicated: QoL, Play Flow, Live Session, and Loot/Profile Studio overlap. |
| Phone UI | The same SPA served by the LAN listener; QR creates a separate in-memory cookie session | Pairing/session primitives are good; there is no first-class `isRemote` capability in the React app. |
| Diagnostics | `watchdog.go`, logger, timestamped reports under the user config directory | Useful crash/hang evidence; retention, privacy scrubbing, and macOS UI probing are incomplete. |
| Releases | Local Windows/macOS packaging scripts plus GitHub Actions release and PR CI workflows | Packaging is reproducible at the source level; signing, notarization, and clean-machine startup remain release-owner gates. |

## 2. What is working well

- Pairing tokens are short-lived and single-use; a different random session cookie is issued (`cmd/riftops-ui/remote_access.go:302-334`).
- Phone sessions are in memory, expire, can be revoked, and are not returned in phone status responses (`cmd/riftops-ui/remote_access.go:408+`, `cmd/riftops-ui/remote_access_test.go:181-190`).
- Mutating remote requests require an exact same-origin check (`cmd/riftops-ui/main.go` origin middleware; `cmd/riftops-ui/remote_access_test.go:135-166`).
- The remote route scope rejects unknown API paths and known desktop endpoints (`cmd/riftops-ui/remote_access.go:363-392`; tests at `remote_access_test.go:92-107`).
- Remote responses set nosniff, frame denial, referrer policy, and a narrow asset CSP (`cmd/riftops-ui/remote_access.go:395-405`).
- Champion-select logic has meaningful pure tests for current turns, occupied champions, timing, and fallbacks (`frontend/tests/champSelectFlow.test.ts`).
- Live-session normalization has pure tests for queue, ready check, labels, and timers (`frontend/tests/liveSession.test.ts`).
- The UI uses an LCU connection provider with visibility-aware refresh and abortable requests (`frontend/src/components/LCUProvider.tsx:44-132`).
- The project documents that Riot passwords are not stored and that normal authentication remains in Riot Client (`README.md:22-23`, `README.md:214-216`).

## 3. Release-blocking findings

### Historical P0 — Phone permissions were not enforced as a product boundary

**Evidence**

- The phone is the same React tree as desktop; `App.tsx` has no remote capability/context (`cmd/riftops-ui/frontend/src/App.tsx:62-104`).
- Settings and QoL are only CSS-hidden in the mobile dock (`Sidebar.tsx:49-52`, `index.css:1621`).
- The command palette still includes `Open League QoL` and `Open Settings` (`CommandPalette.tsx:18-22`), and `App.tsx` accepts all eight tabs from keyboard navigation (`App.tsx:214-238`).
- The current remote allowlist is intentionally limited to live-session state/actions, read-only collection/history, presence, and named launch control (`cmd/riftops-ui/remote_access.go:356-401`). Desktop preferences, update checks, autostart, saved sessions, loot crafting, rune CRUD, cosmetics, diagnostics, and engine administration remain excluded.
- The README says filesystem, credential-session, update, diagnostics, and quit routes are desktop-only (`README.md:80-83`), but `/api/preferences`, `/api/check-update`, `/api/autostart`, `/api/riot-client-location`, and `/api/session-status` are currently remote-allowed.

**Impact**

The earlier audit found phone route drift. The current source has a server capability bootstrap, remote-aware navigation, and deny-by-default route scope; keep the manifest/route inventory tests as a regression gate when adding new APIs.

**Required fix**

Introduce an explicit server capability bootstrap, for example `desktop` versus `phone`, and use it in both layers:

1. The server returns a minimal capability document after authentication.
2. The React app derives `isRemote` once and removes desktop routes/commands at render time.
3. The server has a strict phone route manifest; unknown or desktop-only methods remain forbidden regardless of UI.
4. Add a test that enumerates every registered API route and asserts its intended phone policy.

### Historical P0 — No complete cross-platform release gate

**Evidence (superseded by the current baseline)**

- The original audit predated the Windows release workflow and cross-platform CI workflow.
- Local Windows packaging still requires Fyne/MinGW; hosted packaging installs those tools in its Windows runner.
- Both platform scripts and `.github/workflows/ci.yml` now run the same frontend lint/test/build plus `go test -race -tags desktop ./...` and `go vet -tags desktop ./...` gates.
- The macOS workflow explicitly produces ad-hoc signing only; Developer ID signing/notarization remains a release-owner step (`scripts/build-macos.sh`, `.github/workflows/release-macos.yml`).

**Required fix (completed; retain as a regression gate)**

The source-level implementation is complete: the Windows and macOS release workflows package artifacts, and `.github/workflows/ci.yml` runs the shared frontend and desktop-Go matrix on both platforms. Keep signing/notarization, package validation, and clean-machine startup as explicit release gates rather than implied completion.

### Historical P1 — Race detector found a real settings persistence race

The original audit reported a race in `internal/engine.TestConcurrentPreferenceWritesPersistLatestState`. The current race-enabled desktop suite passes; keep that test in CI so this regression cannot return.

Normal tests pass, but concurrent actions can persist a partially updated active profile or produce nondeterministic settings. Guard settings snapshots and profile synchronization with one lock or serialize all engine mutations through one writer; add a regression test that repeatedly verifies the final persisted state.

## 4. Phone product contract

The phone should be a **live-session remote**, not a second desktop administration console. The following contract is recommended.

### Phone: ship in the first stable phone release

| Surface | Phone policy | Notes |
|---|---|---|
| Pairing/session status | Allow | Show connected state and a clear LAN/HTTP warning. Do not show QR generation, device inventory, or all-device revoke. |
| Home/status | Allow | Current League connection, phase, queue/ready state, account name, and one recommended next action. |
| Live Session | Allow | Queue, ready check, champion select, loading, active game, reconnect, and post-game status. This is the canonical phone page. |
| Ready check | Allow | Accept/decline with immediate result and stale-state handling. |
| Queue | Allow | Start/stop matchmaking and Play Again when phase-valid. Add an explicit “phone controls enabled” desktop preference. |
| Pick/ban | Allow with guardrails | Only when it is the local player’s current action; use a visible timer, occupied-state check, idempotency key, and hold/confirm for lock-in. |
| Fallback pick/ban | Allow | Use the same server-side draft policy as desktop; show which fallback was selected and why. |
| Rune page selection | Allow | Select an existing page for the current pick/fallback. Do not expose full rune CRUD by default. |
| Friends | Allow | Collapsed by default, search, online/favorite filters, and a single refresh source. |
| Presence/status message | Allow | Safe, reversible, and already part of the phone value proposition. |
| Match history | Read-only optional | Paginate and lazy-load; do not make it compete with Live Session. |
| Notifications | Allow | Live RiftOps/League transition feed with `aria-live` updates. |

### Phone: optional second phase, behind explicit opt-in

- Launch/reconnect League from the phone, only if the desktop owner enables “Allow phone launch”.
- Create/leave practice or custom sessions, with a clear destructive action and current-phase confirmation.
- Read-only skin/champion catalogue, heavily lazy-loaded and capped for mobile data usage.
- Profile icon/background selection, only as a separate cosmetic permission.

### Desktop-only

- Settings: Riot Client path, Browse/Auto-detect/Clear, startup/autostart, performance mode, update preferences, cache clearing, reset workspace, and app quit.
- Phone-control administration: enable/disable listener, generate/replace QR, copy pairing link, view/revoke devices.
- Full QoL configuration: grind mode, auto-accept/auto-queue/auto-honor/auto-reward, queue presets, and automation policy editing.
- Full Play Flow policy editor and rune-page create/update/delete.
- Loot Workshop crafting and any resource-consuming action.
- Account/profile/session vault, import/export, profile switching, or any remembered-login/session metadata.
- Diagnostics/log viewer/reports and filesystem/process details.
- Presence engine enable/disable if the owner wants to prevent a phone from changing the desktop’s global masking state; alternatively expose it as a separately permissioned shared control.

### Never expose remotely

- Riot passwords, tokens, lockfile credentials, process command lines, certificate material, raw diagnostics, filesystem browsing, arbitrary command execution, update installation, or a route that quits RiftOps itself.

## 5. Current remote API disposition

The existing allowlist is a useful starting point but mixes three different classes. Refactor it into named policy groups rather than one flat map.

| Current group | Examples | Recommended disposition |
|---|---|---|
| Safe read state | `/api/snapshot`, `/api/events`, `/api/lcu/overview`, gameflow, friends, health, server status, match history | Keep; redact paths and cap payloads. |
| Live-session actions | ready, queue, Play Again, champion-select action/selection, reroll/bench, rune select, presence/status message | Keep with phase checks, idempotency, stale-state responses, and per-device permission. |
| Desktop settings currently allowed | `/api/preferences`, `/api/save-preferences`, `/api/autostart`, `/api/set-autostart`, `/api/check-update`, `/api/riot-client-location`, `/api/profiles`, `/api/session-status` | Remove from phone manifest. |
| Engine controls currently allowed | `/api/start`, `/api/stop`, `/api/set-enabled`, `/api/set-status`, `/api/lcu/launch-league` | Split: status/presence may be opt-in; engine stop/launch require explicit phone permission. |
| Automation configuration currently allowed | `/api/qol/preferences`, `/api/qol/queue-presets`, `/api/auto-roles` | Desktop-only configuration; phone can invoke a saved policy, not edit it. |
| Destructive/economy mutations | `/api/lcu/loot/craft`, rune page PUT/DELETE, rewards, honor, profile icon/background | Desktop-only by default; expose only individually permissioned actions later. |
| Catalogue/assets | Data Dragon, CommunityDragon, skins, loot, champion data | Read-only; lazy-load and cap on phone. |

## 6. Reliability and performance findings

### State polling is fragmented — P1

`LCUProvider` polls the overview as often as 900–3000 ms during active phases (`frontend/src/components/LCUProvider.tsx:44-132`), while `App.tsx` separately polls snapshot/SSE (`App.tsx:159-205`), `ChampSelectWorkspace` polls every realtime interval (`ChampSelectWorkspace.tsx:180-191`), `FriendsPanel` polls every `max(10s, pollInterval*2)` (`FriendsPanel.tsx:77-82`), and `HealthIndicator` polls external server status (`HealthIndicator.tsx:64-70`). This creates duplicate LCU calls, competing refreshes, stale overwrites, higher phone battery use, and more opportunities for “refresh fixes it” behavior.

Replace panel polling with one backend snapshot/event stream and one frontend query cache/store. Panels subscribe to slices, and only the Live Session controller increases cadence while an action timer is active.

### Historical P1 — LCU response bodies were unbounded

The original audit reported unbounded reads at `internal/riotclient/lcu.go:401`. The current client uses bounded readers and redacted/truncated error text, with regression coverage in `internal/riotclient/lcu_test.go`. Keep those limits in place when adding endpoints.

The loopback LCU uses `InsecureSkipVerify` with `ServerName=127.0.0.1` (`internal/riotclient/lcu.go:79-81`). This is an intentional self-signed loopback compatibility decision, but keep it narrowly scoped to the loopback client and test that remote URLs cannot enter this client.

### Watchdog coverage differs by OS — P2

Windows has a WebView2 message-loop probe; macOS and unsupported platforms return `false` from `pumpUIThread` (`cmd/riftops-ui/webview_darwin.go:22-25`, `webview_other.go:21-22`). The macOS watchdog therefore tests the local API but not native UI responsiveness. Add a macOS WebKit heartbeat or document the reduced guarantee.

### Historical P2 — Diagnostics needed retention/privacy policy

The original audit requested retention and privacy controls. The current diagnostics implementation rotates logs, scrubs authorization/query/path material, applies private permissions where supported, retains at most 20 reports for 30 days, and keeps report listing desktop-only. Keep this behavior covered when report fields change.

## 7. UI/UX and mobile audit

The mobile layout is thoughtfully started (safe-area bottom dock, hidden desktop nav, phase-aware pages), but the architecture remains desktop-first.

- `#root` globally uses `overflow: hidden` (`index.css:40`) and each page chooses its own scroll container; QoL is wrapped with `overflow-hidden` in `App.tsx:500-503` while `.qol-page` supplies a nested scroll container (`index.css:673-681`). This is fragile and matches the reported “page cannot scroll” class of regressions. Use one page-level scroll owner per route and test at 320/375/430 px widths.
- Skin, loot, rune, champion, and match-history lists are large; the guidelines require virtualization or `content-visibility` for lists over 50 items. Add mobile pagination/windowing and lazy images.
- Remote and desktop use the same command palette; remove unavailable commands instead of relying on hidden nav.
- Toasts and live status updates should use `aria-live="polite"`; the QoL toast bar currently has no live region (`QoLPanel.tsx:172-179`).
- Global CSS still contains `transition: all` (`index.css:240`, `271`, `282`); use explicit properties and honor `prefers-reduced-motion`.
- Inputs/selects need consistent `name`/`autocomplete` metadata. Native select colors are now explicitly dark (`index.css:203-224`), which is good; preserve this in every modal/phone surface.
- Meaningful images should have dimensions to avoid layout shift. The pairing QR image (`RemoteAccessCard.tsx:73`) and several catalogue images do not declare width/height.
- Destructive actions should not be immediate on an untrusted small screen. Keep the requested fast custom/practice quit on desktop, but use an explicit hold/confirm policy on phone for dodge, custom quit, loot craft, and lock-in.

## 8. Test and coverage audit

### Commands run (current baseline)

| Command | Result |
|---|---|
| `go test -tags desktop ./...` | Pass |
| `go vet -tags desktop ./...` | Pass |
| `go test -race -tags desktop ./...` | Pass |
| `go test -cover -tags desktop ./...` | Pass; notable coverage: UI 11.8%, engine 22.6%, LCU 29.7%, Riot API 6.7% |
| `npm run lint` | Pass |
| `npm test` | Pass, 30 frontend tests |
| `npm run build` | Pass; Vite output ~467 kB JS / ~248 kB CSS before compression |

### Missing coverage

- No React component tests for route gating, phone navigation, settings hiding, error states, or accessibility.
- No responsive screenshot/DOM tests at phone breakpoints. Browser validation remains an explicit release gate and was not run here.
- No test that every route in the main mux has an intended phone policy.
- No end-to-end LCU test against a fake lockfile/client for pick, ban, hover, rune select, quit, and stale-action behavior.
- No LAN/firewall/QR scan/8-hour expiry/foreign-origin test across a real phone browser.
- No clean Windows WebView2 or macOS WebKit startup test, no clean-machine install/uninstall test, and no notarized Gatekeeper test.
- Live League, phone/firewall, clean-machine, and signed/notarized startup checks remain environment-owned release gates.

## 9. Recommended implementation order

### Phase 0 — release safety

1. Keep the settings/profile lock and race-enabled desktop suite green.
2. Keep bounded LCU response reads and safe error redaction covered by tests.
3. Keep macOS and Windows scripts on the same frontend and desktop-Go gates.
4. Close environment-owned signing, live smoke, and inherited TLS-domain gates before a public release.

### Phase 1 — phone boundary

1. Add server capability bootstrap (`desktop`/`phone`) and strict phone route manifests.
2. Remove Settings/QoL/update/path/autostart/profile/session/loot-craft/rune-CRUD routes from phone.
3. Replace the shared command palette with capability-filtered commands.
4. Make Live Session the only phone workflow; expose small, safe live actions.
5. Add an explicit desktop permission for phone launch and destructive actions.

### Phase 2 — state/reliability

1. Build one LCU snapshot/event store and remove duplicate panel timers.
2. Add action idempotency and stale-state conflict responses for champion select.
3. Add reconnection/backoff/offline cache behavior and visible “last updated” state.
4. Add diagnostics retention/redaction and an OS-specific watchdog heartbeat.

### Phase 3 — phone UX

1. Define one scroll owner per page and test 320/375/430 px layouts.
2. Virtualize/paginate skin, loot, history, champion, and rune catalogues.
3. Add live-region announcements, focus traps for dialogs, keyboard alternatives, explicit image dimensions, and reduced-motion variants.
4. Only then add optional read-only skins/profile cosmetics to the phone.

## 10. Release acceptance checklist

- [x] `go test -race -tags desktop ./...` and `go vet -tags desktop ./...` pass locally and are required in CI.
- [x] Frontend lint/test/build pass locally and are required in CI.
- [ ] Windows and macOS artifacts are attached to the same release with SHA-256 checksums.
- [ ] Windows WebView2 and macOS WebKit start on clean machines without a console window.
- [ ] macOS Developer ID signing/notarization and Gatekeeper acceptance are verified.
- [ ] Phone pairing is one-use, expiring, revocable, same-origin checked, and LAN-only.
- [ ] A paired phone cannot open Settings/QoL configuration or call any desktop-only route, even by direct HTTP or command search.
- [ ] Phone pick/ban/ready/queue actions are phase-aware, idempotent, stale-safe, and visibly acknowledged.
- [ ] No phone route exposes Riot credentials, lockfile values, filesystem paths, diagnostics, or update/install controls.
- [ ] Live phone smoke test covers lobby → queue → ready → champion select → loading → in-game → post-game.
- [ ] Offline/reconnect and League restart flows are tested without manual refresh.
- [ ] Reports are redacted, rotated, private, and never remotely downloadable.

## Final verdict

Keep the current desktop feature set as the primary product. Reframe the phone as a narrowly permissioned Live Session remote, then add optional read-only catalogue features later. The current pairing cryptography and route-scope primitives are worth keeping, but they must be connected to an explicit phone capability model. Until the race, boundary, CI, and live-smoke gates above are closed, label the phone feature **experimental LAN control**, not a complete Mimic-equivalent release.
