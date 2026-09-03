# RiftOps feature comparison and roadmap

This document records the feature comparison between RiftOps and three related
League tools:

- [League Profile Tool](https://github.com/lenny-ts/league_profile_tool)
- [KBotExt](https://github.com/KebsCS/KBotExt)
- [Sona](https://github.com/WJZ-P/sona/blob/main/README.en-US.md)

It is a planning reference, not a promise that every feature in another
project is supported by Riot, safe to use, or appropriate for RiftOps.

## Status key

- **Present** — RiftOps has the capability today.
- **Partial** — RiftOps has related functionality, but not the same depth or
  workflow.
- **Missing** — not currently implemented.
- **Excluded** — deliberately not planned because it is unsafe, unsupported,
  invasive, or likely to trigger anti-cheat enforcement.

## Executive summary

RiftOps already covers the modern, safer core: cross-platform launch, encrypted
session profiles, presence and chat controls, live League state, Champion
Select automation, pick/ban fallbacks, rune selection, Arena support, skin and
loot views, diagnostics, and restricted phone control. The current inventory
is maintained in [FEATURE_PARITY.md](FEATURE_PARITY.md).

The largest useful gaps are profile/social polish from League Profile Tool,
small read-only League utilities from KBotExt, and Sona's Champion Select
analysis, smart builds, match tools, and client presentation. KBotExt also
advertises spoofing, exploit, debugger, and evasion behavior. Its README
explicitly warns that the tool is bannable by Vanguard, so those items are
recorded as excluded instead of being copied.

## League Profile Tool comparison

The repository describes a Tauri/React desktop app focused on profile
customization, social management, and a polished LCU workflow. The table below
compares those documented capabilities with RiftOps.

| Capability advertised by League Profile Tool | RiftOps | Notes |
|---|---|---|
| Categorized navigation and collapsible sidebar | **Present** | RiftOps has grouped desktop workspaces and a collapsible sidebar. |
| Live profile dashboard with summoner icon, level, and Riot ID | **Present** | Available from Command Center/Profile Studio. |
| Set a profile background from any champion skin | **Present** | RiftOps supports any champion skin, not only owned skins. |
| Bulk friend manager with Riot ID search and delete progress | **Present** | Social Center provides desktop-only reviewed operations with progress, cancellation, rate limits, and redacted receipts. |
| Profile tokens/challenge medals with image picker | **Partial** | Profile Studio reads client-exposed regalia and challenge metadata; mutation stays unavailable when ownership semantics are not stable. |
| Last.fm scrobbling and music-linked profile presence | **Missing** | Optional integration; requires explicit consent and privacy documentation. |
| Long bio editor, ASCII art, idle text, and music-sync toggle | **Partial** | RiftOps has presence/status controls, but not the music and idle-text tools. |
| Rank mirror for visible Solo/Duo rank with draft previews | **Missing** | Do not implement spoofing unless Riot exposes a supported cosmetic setting. |
| 6,000+ profile icons with descriptive names | **Present/Partial** | RiftOps merges the official Data Dragon catalogue with LCU names and ownership badges; patch gaps remain labelled. |
| Presence values Online/Away/Mobile/Offline | **Present** | RiftOps supports presence masking and status updates. |
| Auto-growing textareas and 255-character counters | **Present** | Profile Studio and the QoL status editor enforce the 255-character limit and show a live counter. |
| Version-aware local metadata cache and JPG previews | **Partial** | RiftOps has catalogue fallbacks, but no equivalent documented cache UX. |
| Secure ED25519-signed auto-updater | **Partial** | RiftOps has update checks; signed update verification should be evaluated for a future release. |
| CodeQL, SonarCloud, Dependabot, and VirusTotal release reporting | **Missing** | These are project/release-process improvements rather than user features. |

### Highest-value additions from this project

1. Friend management with bulk actions, progress, and recovery after partial
   failure.
2. Profile challenge/token editor where current LCU support is verified.
3. Named icon metadata, filters, and clearer ownership/availability states.
4. Consistent bio character counters and profile preview states.
5. Optional music integration only after an explicit privacy decision.

## KBotExt comparison

KBotExt describes itself as an all-in-one custom LCU request tool. Its README
lists the following behavior. Some entries are useful quality-of-life ideas;
others are unsupported or explicitly dangerous.

### Client, queue, and Champion Select

| KBotExt capability | RiftOps | Notes |
|---|---|---|
| Claimed compatibility with every patch | **Partial** | RiftOps has focused route tests and live-client release gates; no tool can guarantee every future patch. |
| Free ARAM boost | **Excluded** | Unsupported behavior and a likely account-risk feature. |
| Launch multiple League clients | **Partial** | RiftOps supports named sessions, but its safe workflow is centered on one active Riot client. |
| Change League client language | **Missing** | Candidate desktop-only setting if it can be implemented without file patching. |
| Start any lobby or game mode | **Excluded/Partial** | RiftOps supports documented lobby and custom-game routes; hidden or unsupported modes stay excluded. |
| Custom bot difficulty | **Present** | Preparation exposes the client-provided bot catalogue and validates champion, team, and difficulty before adding. |
| Fast instalock, auto-accept, instant message, and auto-ban | **Partial** | RiftOps has auto-accept, timing policies, pick/ban automation, and fallbacks; no bulk instant-message tool. |
| Pick a secondary champion or dodge if the primary is unavailable | **Present** | Covered by conflict-aware pick/ban fallback policy. |
| Instantly mute everyone in Champion Select | **Present** | Champion Select offers individual mute and a client-backed mute action; no hidden-player recovery is attempted. |
| Dodge without closing the League client | **Present** | RiftOps exposes Champion Select dodge and keeps the app running. |
| Mass invite all friends | **Present** | Social Center limits desktop reviewed invites to 20 and sends them sequentially at 500 ms intervals. |
| OP.GG/U.GG/Poro multi-search for lobby players | **Missing** | Safe version would open read-only external links; do not reveal restricted ranked data. |
| Best runes from OP.GG, including when runes are locked | **Partial** | RiftOps supports rune-page selection and fallback pages; external recommendations are not integrated. |
| Map-side display for all modes | **Partial** | Live Session shows the side/map only when the current LCU session exposes it. |
| Hidden modes and Nexus Blitz lane forcing | **Excluded/Partial** | Only documented, currently supported LCU routes should be considered. |

### Profile, social, and collection

| KBotExt capability | RiftOps | Notes |
|---|---|---|
| Custom icon, background, status, rank, mastery, and challenge display for everyone | **Partial/Excluded** | Background, owned icons, and presence are supported; rank/mastery/challenge spoofing is excluded. |
| Glitched or empty challenge badges/tokens | **Excluded** | Unsupported cosmetic manipulation. |
| Invisible profile/lobby banner | **Excluded** | Unsupported client manipulation. |
| Inspect arbitrary player information by nickname or ID | **Missing** | Consider a privacy-respecting, read-only lookup only where Riot documents it. |
| Champion and skin lists with sorting | **Present** | RiftOps has Collection/Skin Showcase with ownership-aware filtering and sorting. |
| Bulk-delete friends by folders | **Present** | Desktop Social Center supports selected reviewed removals with revalidation and cancellation. |
| Accept or delete all friend requests | **Present** | Desktop Social Center supports reviewed sequential accept/decline batches. |
| Check account email | **Missing/Excluded** | Do not expose sensitive account data without a supported, user-authorized endpoint. |
| Champion name-to-ID helper | **Missing** | Small, low-risk utility for internal tools and diagnostics. |

### Loot, client, and diagnostics

| KBotExt capability | RiftOps | Notes |
|---|---|---|
| Force-close the League client instantly | **Partial** | RiftOps can stop/restart supported client processes through its platform layer. |
| Custom in-game minimap scale | **Excluded** | RiftOps does not modify game files or inject into the game client. |
| One-click mass disenchant | **Partial** | Loot Workshop uses live discovered recipes and explicit confirmations; broad bulk actions remain intentionally bounded. |
| Arbitrary LCU/Riot/RTMP/Store/Ledge request console | **Excluded** | No unrestricted request console, especially not through phone remote access. |
| Stream-proof behavior | **Excluded** | Evasion behavior is outside RiftOps’ safety boundary. |
| IFEO debugger support for Fiddler/Charles | **Excluded** | Debugger injection and process interception are not product features. |
| Log cleaner | **Partial** | RiftOps has redacted diagnostics and retention controls; never delete evidence silently. |
| Ban checker | **Missing** | Could be a read-only account-status explanation, but no tool can promise ban safety. |
| Automatically save preferences | **Present** | RiftOps persists settings and launch/automation preferences. |
| Unicode support and configurable window size | **Present/Partial** | Native UI supports normal Unicode; responsive sizing continues to be polished. |
| One-click login with automated client opening | **Present** | RiftOps uses encrypted named session profiles and launches the client; Riot handles password prompts when a session expires. |
| Force client without administrator rights | **Partial** | RiftOps avoids unnecessary elevation where the operating system and Riot allow it. |
| Patched free champion/skin/refund exploits | **Excluded** | Never implement exploit or entitlement bypass behavior. |

## Sona comparison

Sona is a React plugin that runs inside the League Client Chromium environment
through Pengu Loader. It combines LCU REST calls, WebSocket events, external
recommendation data, and DOM injection. That architecture enables deeper
League-client presentation changes than RiftOps' standalone window, but it also
adds a Pengu Loader dependency and makes DOM features sensitive to League
client updates.

### Match and Champion Select

| Sona capability | RiftOps | Plan |
|---|---|---|
| Auto-accept with optional random delay and post-accept decline | **Partial** | Keep current auto-accept; add configurable bounded delay and clear cancellation state. |
| Priority queues for multiple auto-pick and auto-ban candidates | **Partial** | RiftOps has primary/fallback choices; generalize to ordered candidate lists after current policy tests remain stable. |
| ARAM bench swaps without cooldown | **Partial/Excluded** | Normal bench actions are present; never bypass a server-enforced cooldown. |
| Blue/red side indicator in Champion Select chat | **Missing** | Add a read-only side indicator; chat announcement must be optional. |
| Team power analysis using recent mode-specific win rate and KDA | **Missing** | Add transparent read-only metrics with sample size, source, and unavailable states. |
| Champion Select Assist with teammate stats, tier badges, and match links | **Partial** | RiftOps shows draft participants; add permitted stats and external history links without deanonymizing protected players. |
| Streamer/privacy-mode support and player-swap tracking | **Missing/Partial** | Track swaps, but preserve Riot's hidden-name boundary instead of restoring concealed identities. |
| In-game team analysis popup with rank and premade groups | **Partial** | Live Session has game telemetry; add a non-intrusive pre-game summary where data is permitted. |
| Quick quit button during non-custom Champion Select | **Present** | Existing dodge/quit flow remains phase-aware. |
| Auto-return to lobby with optional requeue and retries | **Present** | Existing auto-return/auto-start behavior should gain visible retry history. |
| Mode-specific champion balance modifier tooltip | **Missing** | Add a versioned read-only catalogue with source and patch date. |
| Automatic honor | **Present** | Current implementation honors the first eligible teammate; future UI can expose strategy choices. |
| Lobby avatars linked to match history and recent performance | **Partial** | Add click-through lobby cards while keeping current lobby controls compact. |

### Smart builds

| Sona capability | RiftOps | Plan |
|---|---|---|
| Automatically sync items, runes, and spells after champion lock-in | **Partial** | RiftOps selects runes and keeps local item plans; add explicit, reversible sync with a preview. |
| Remember manually saved runes and spells per champion and mode | **Present** | Preparation presets are account-scoped and include champion, queue family, role, rune pages, and summoner spells. |
| Position-aware recommendations with manual role override | **Missing** | Use assigned role when available and always expose the chosen role/source. |
| OP.GG panel for items, runes, spells, augments, and matchups | **Missing** | Add an attributed provider layer with caching, timeouts, and honest missing-data states. |
| Managed item sets that preserve user-created sets | **Present** | Managed sets use a `RiftOps:` prefix, merge with the complete document, and snapshot before writes. |
| Standard/special-mode recommendation fallbacks | **Partial** | Reuse RiftOps' existing fallback policy, but keep provider and mode fallbacks visible. |

### Match history

| Sona capability | RiftOps | Plan |
|---|---|---|
| Player lookup by Riot ID | **Missing** | Add read-only lookup where Riot permits it; rate-limit and avoid retaining searches. |
| Match-history queue/mode filters | **Present** | RiftOps already provides queue and period filters. |
| Detailed match view with builds, runes, spells, CS, gold, damage, map, and time | **Present/Partial** | Most fields are present; fill gaps only when returned by LCU or Match-V5. |
| Copy Game ID | **Present** | Available from Live Session; expose it consistently in Match History. |

### Social and profile

| Sona capability | RiftOps | Plan |
|---|---|---|
| Unlock client-side status message editing | **Present** | RiftOps exposes presence and status controls. |
| Offline/mobile availability with startup restore | **Present** | Covered by presence masking and remembered preferences. |
| Searchable custom profile background from any skin | **Present** | Keep the current any-skin background workflow. |
| Locally displayed challenge banner | **Missing/Gated** | Cosmetic-only feature; requires an optional client companion and must be labelled local-only. |
| Premade friend markers using shared colors | **Missing** | Add read-only markers when party membership is exposed. |
| Friend mode and elapsed game time in the social sidebar | **Missing** | High-value Social panel enhancement using available presence fields. |
| Local rank disguise on friend cards | **Missing/Gated** | Low priority, local-only cosmetic; never imply ranked data changed. |
| Remove profile crest decoration | **Missing/Gated** | Client-DOM cosmetic requiring the optional companion. |
| Restore default client avatar | **Missing** | Add only if a documented local profile/reset operation exists. |

### League-client presentation

| Sona capability | RiftOps | Plan |
|---|---|---|
| Dedicated client beautification page | **Missing/Gated** | Requires an optional in-client companion; it does not belong in the standalone LCU core. |
| Custom Home Wallpaper using images/videos with blur, tint, crop, and position | **Missing/Gated** | Companion-only visual feature with local asset validation. |
| Wallpaper mode and scene-glass effects | **Missing/Gated** | Companion-only and version-sensitive. |
| Random wallpaper on client start without immediate repeats | **Missing/Gated** | Companion-only; store local history without scanning unrelated files. |
| Independent friends-sidebar glass controls | **Missing/Gated** | Companion-only and version-sensitive. |
| Top-navigation blur, separators, and border styling | **Missing/Gated** | Companion-only and version-sensitive. |
| Multiple custom local avatars with peer synchronization | **Missing/Gated** | Requires hidden status payloads and another Sona-compatible peer; not part of the standalone core. |
| Flowing gradient summoner names across social/lobby/draft | **Missing/Gated** | Companion-only cosmetic; accessibility and reduced-motion controls required. |
| Local asset manager and path normalization | **Missing/Gated** | Build only with a companion; constrain access to a RiftOps-owned asset directory. |

### Tools and interface

| Sona capability | RiftOps | Plan |
|---|---|---|
| Replay Tool to download and watch replays by Game ID | **Present** | Match History exposes availability, download, progress, and idle-only Watch actions through typed local replay routes. |
| Back up and restore League settings per account | **Present** | Desktop Safe Utilities keep ten account-scoped snapshots, show a restore preview, and roll back on failure. |
| Selective Battle Pass Rewards for individual pending items | **Present/Partial** | Safe Utilities render server-provided pending groups and submit only an explicitly selected reward; unsupported patches fail closed. |
| Blur, acrylic, mica, and other window effects | **Partial** | RiftOps has its own themed shell; native effects must degrade gracefully by platform. |
| Global background particles | **Missing/Gated** | Optional cosmetic with reduced-motion and performance limits. |
| Quick Lobby from a configured queue | **Present** | Play Flow includes named queue/role presets and explicit apply actions using only the available-queue catalogue. |
| Hide unwanted game modes in the client selector | **Missing/Gated** | Companion-only UI preference; never alter server queue availability. |
| Hide TFT entry, navbar labels, and esports popups | **Missing/Gated** | Companion-only client cleanup with per-item toggles. |
| Restore hidden Chromas collection tab | **Missing/Gated** | Companion-only and patch-sensitive; RiftOps already shows chromas in its own Collection view. |
| Startup update checker with open/skip choices | **Present/Partial** | RiftOps has update checks; improve release notes and skip-version controls. |
| Internationalization with Simplified Chinese, English, and automatic language detection | **Partial** | RiftOps ships English/Arabic local catalogues, system-language defaulting, persisted locale, and runtime RTL; more locales are intentionally deferred. |
| Advanced LCU/chat/replay/build/status debug panel and mocks | **Present/Partial** | Safe Utilities expose redacted capability status and typed replay/build/status controls without arbitrary request execution. |

### Sona constraints relevant to RiftOps

- Sona requires Pengu Loader and cannot run standalone.
- It does not inject into the game process or modify game files; its visual
  features operate in the League Client Chromium UI.
- Custom avatars and flowing names use hidden status payloads and require both
  friends to run compatible tooling.
- OP.GG and ARAM.GG recommendations depend on third-party availability.
- DOM-based features can break when League changes its client structure.

## What RiftOps has that these projects do not emphasize

- Windows and macOS support from one native Go/Fyne codebase.
- Encrypted named session profiles using Windows DPAPI or macOS Keychain.
- A local chat/presence proxy with certificate handling and no predecessor-owned
  remote certificate service.
- A unified Live Session page covering queue, ready check, Champion Select,
  loading, active game, reconnecting, and post-game.
- Read-only Game Client Data API telemetry for active games.
- Match-V5 history fallback when configured by the user.
- Server-enforced phone permissions that keep settings, credentials, crafting,
  rune editing, cosmetics, diagnostics, and filesystem controls off the phone.
- Explicit pick/ban timing, fallback candidates, rune fallback, role/pick-order
  requests, ARAM actions, and Arena Bravery handling.
- Redacted diagnostics, bounded LCU responses, incremental XML framing, and
  tests for common reconnect and error paths.

## Consolidated delivery model

The three reference projects use different technical surfaces. RiftOps should
not mix them into one fragile path.

| Surface | Responsibility | Examples | Phone access |
|---|---|---|---|
| Standalone RiftOps core | LCU/WebSocket actions, launch, sessions, state, local persistence | Queue, draft, friends, profile, history, replay, settings backup | Read-only and reversible named actions only |
| External intelligence providers | Optional third-party recommendations and history links | OP.GG, U.GG, Poro, ARAM.GG, Last.fm | Read-only after explicit opt-in |
| Optional in-client companion | League Chromium presentation and DOM-only enhancements | Wallpaper, glass, client cleanup, local banners, particles | No remote administration |
| Excluded boundary | Exploits, entitlement bypass, evasion, deanonymization, arbitrary requests | Free boosts, refund exploits, IFEO, Vanguard evasion, unrestricted consoles | Never exposed |

The standalone core remains useful without any provider or companion. External
providers fail independently. The optional companion must never receive saved
sessions, Riot credentials, filesystem-wide access, or unrestricted process
control.

## Consolidated implementation plan

### Phase 0 — capability and safety foundation

Purpose: establish one reliable path before adding more LCU and third-party
features.

1. Maintain a version-aware capability registry for every planned LCU action:
   route, method, supported phases, ownership requirements, fallback, and last
   live validation patch.
2. Centralize League state subscriptions so Social, Play Flow, Live Session,
   builds, and phone views consume one event stream instead of independent
   polling loops.
3. Define provider contracts for recommendations and lookups with attribution,
   cache age, timeout, rate-limit, and unavailable states.
4. Add per-account settings namespaces without placing secrets in normal
   settings or exports.
5. Extend the existing phone capability matrix for each new route before its
   handler is registered.
6. Add feature flags only for provider-dependent or companion-dependent
   capabilities, not for ordinary completed features.

Acceptance gate:

- Unsupported routes produce a clear unavailable state instead of retries or
  generic errors.
- One state transition is reflected consistently across desktop and phone.
- Mutating endpoints remain blocked remotely unless explicitly listed.
- Logs redact lockfile credentials, session data, Riot tokens, and private
  provider credentials.

### Phase 1 — Social and Profile Studio

Sources: League Profile Tool, KBotExt, and Sona.

1. Build a desktop friend manager with Riot ID search, folder filters, bulk
   selection, invite, remove, accept-request, and decline-request actions.
2. Require a review step for every bulk mutation and show per-player progress,
   partial failures, cancellation, and a final receipt.
3. Enhance Social cards with current mode, elapsed game time, premade color
   markers, and a direct Match History action when Riot exposes the fields.
4. Expand profile-icon metadata to named, searchable, categorized entries with
   owned/available/unsupported states and reliable image fallbacks.
5. Add supported challenge-token/medal editing with a visual preview and
   ownership validation.
6. Standardize bio/status editors with auto-growth, a 255-character counter,
   offline/mobile/away controls, startup restore, and explicit server feedback.
7. Add profile presets for safe fields: background, owned icon, status, and
   supported challenge tokens.
8. Keep local-only banners, rank presentation, crest removal, and peer-synced
   avatars out of this phase; they belong behind the companion decision gate.

Acceptance gate:

- Bulk actions never execute from a single accidental click.
- Friend progress survives individual failures without repeating successes.
- Unowned or unsupported profile assets are visibly distinguished.
- Social updates arrive from the shared event stream without manual refresh.

### Phase 2 — Champion Select intelligence and automation

Sources: KBotExt and Sona, extending RiftOps' existing Play Flow policy.

1. Generalize primary/fallback pick and ban into ordered candidate queues while
   retaining immediate, delayed, and last-second timing.
2. Add bounded random delay for auto-accept and a visible decline/cancel action
   where the current ready-check state permits it.
3. Add blue/red side detection, optional chat announcement, and map-side display.
4. Add Champion Select Assist cards with permitted recent win rate, KDA, sample
   size, champion tier, clickable history, and transparent data sources.
5. Add mode-specific team analysis and a documented strength calculation; show
   confidence/sample size rather than presenting it as a prediction.
6. Track teammate swaps and premade groups, but never restore identities Riot
   intentionally hides in anonymous or streamer-protected queues.
7. Add mode-specific champion balance-buff tooltips from versioned data.
8. Add reversible mute-all controls and optional templated lobby messages with
   rate limits; never send messages automatically by default.
9. Enhance lobby member cards with avatar, role, recent performance, and Match
   History links without crowding the primary pick/ban workflow.
10. Preserve current dodge/quit, spells, skins, runes, ARAM bench/reroll,
    role/pick-order swaps, Arena Bravery, and server-confirmed fallback behavior.

Acceptance gate:

- Every automated action verifies current phase, turn ownership, availability,
  and server response immediately before mutation.
- Candidate selection skips banned, picked, unavailable, and conflicting
  champions deterministically.
- Analysis is read-only, source-labelled, and does not deanonymize players.
- Draft automation remains usable when all external providers are offline.

### Phase 3 — Smart Builds and per-champion presets

Sources: Sona and KBotExt.

1. Add an attributed recommendation panel for items, runes, summoner spells,
   augments, and matchups using approved providers.
2. Resolve assigned ranked position first, fall back to mode/champion role data,
   and allow an explicit Top/Jungle/Mid/ADC/Support override.
3. Save manual rune and spell presets per account, champion, role, and mode.
4. Apply the selected rune/spell preset only after champion resolution; primary
   and fallback champions keep independent presets.
5. Convert local six-item plans into optional RiftOps-managed League item sets.
   Tag ownership and preserve every user-created or third-party set.
6. Add standard, ARAM, Arena, and special-mode fallbacks with provider/source
   labels and cache age.
7. Keep a preview/confirm option for every automatic build mutation and expose
   the last applied preset with a restore action.

Acceptance gate:

- No user-created rune page or item set is silently overwritten.
- Champion, mode, and role keys prevent presets leaking into the wrong queue.
- Provider timeouts cannot delay hover, pick, ban, or lock-in actions.
- Fallback behavior is deterministic and covered by fixtures for missing data.

### Phase 4 — Match, replay, lobby, loot, and account utilities

Sources: all three projects.

1. Add Riot ID player lookup with no persistent search history by default.
2. Complete Match History parity for queue filters, builds, runes, spells, CS,
   gold, damage, map, duration, participants, and Game ID copy using only fields
   returned by LCU or Match-V5.
3. Add replay download/watch by Game ID with eligibility, region, version,
   progress, cancellation, and integrity error states.
4. Add saved Quick Lobby shortcuts for documented queues and Practice Tool.
5. Add supported bot difficulty selection for custom/practice lobbies.
6. Add League language controls only through Riot-supported launch or settings
   mechanisms; never patch binaries.
7. Add per-account League settings backup/restore with versioned manifests,
   file preview, explicit restore confirmation, and rollback copy.
8. Replace claim-all-only rewards with a selectable review when stable reward
   IDs are available; keep claim-all as an explicit choice.
9. Add safe batch loot disenchant/crafting with recipe previews, totals, limits,
   per-item results, and no automatic execution.
10. Add small read-only utilities: champion name/ID lookup, account-status
    explanation, current queue/mode IDs, and copyable diagnostics.
11. Evaluate multi-client launch as a separate architecture decision. It must
    not share session-vault data, ports, chat proxies, or settings implicitly.

Acceptance gate:

- Replay and lookup failures identify region/version/unavailable causes.
- Settings restore cannot write outside validated Riot settings directories.
- Loot/reward operations show exact affected items before confirmation.
- Hidden queues and unsupported game modes are not presented as usable.

### Phase 5 — optional League-client companion

Source: Sona. This phase requires a separate explicit product decision because
the current standalone application cannot safely deliver DOM-only features.

1. Define a minimal companion protocol containing non-secret feature settings
   and state; do not expose session profiles, lockfiles, or arbitrary commands.
2. Add a Beautify page for image/video wallpaper, blur, tint, crop, position,
   random rotation, scene glass, social-sidebar glass, and top-navigation style.
3. Add opt-in client cleanup for TFT entry, navbar labels, broadcast popups, and
   queue-list visibility without changing server-side availability.
4. Add local-only challenge banners, crest visibility, rank-card presentation,
   default-avatar reset, and Chromas-tab restoration with honest labels.
5. Add optional particles and flowing-name effects with reduced-motion,
   contrast, battery, GPU, and frame-rate limits.
6. If peer-synchronized custom avatars are ever considered, document that both
   users need compatible tooling and isolate hidden payloads from real presence
   and account data.
7. Restrict local assets to a RiftOps-owned directory with type, size, path,
   and video-decoding validation.

Acceptance gate:

- Disabling or uninstalling the companion returns the League Client to normal.
- A League DOM update fails closed without blocking queue or Champion Select.
- Cosmetic features are labelled local-only when other players cannot see them.
- No companion code touches the game process or modifies game binaries.

### Phase 6 — integrations, accessibility, and release quality

Sources: League Profile Tool and Sona.

1. Add optional Last.fm scrobble-based status/bio with separate connect,
   disconnect, pause, and delete-data controls.
2. Introduce translation catalogues, automatic locale detection, manual
   override, and an English fallback; start with English and Simplified Chinese.
3. Add version-aware metadata/image caching with size limits, invalidation,
   offline fallbacks, and a visible refresh action.
4. Improve update UX with signed metadata, skipped-version controls, release
   notes, download progress, and clear restart behavior.
5. Add CodeQL, Dependabot, static analysis, dependency review, and malware-scan
   reports to release CI where services are available.
6. Expand diagnostics into safe capability, provider, replay, build, and status
   inspectors with mocked payloads; never display auth headers or raw tokens.
7. Add graceful native blur/acrylic/mica where supported and retain a low-cost
   rendering path for small or low-power systems.
8. Audit keyboard navigation, screen-reader labels, contrast, reduced motion,
   localization expansion, and all supported phone widths before release.

Acceptance gate:

- Optional network integrations remain disabled until the user enables them.
- Cache and translation failures do not block local LCU functionality.
- Release artifacts pass tests, static checks, checksum generation, signing
  verification when configured, and clean-machine smoke tests.

## Definition of done for every new feature

1. Current route/provider behavior is verified against primary documentation or
   a live representative response; copied competitor behavior is not evidence.
2. API ownership, allowed phases, retry policy, timeout, and phone permission
   are documented.
3. UI covers loading, success, empty, unsupported, permission-denied, partial,
   offline, and retry states without requiring manual refresh.
4. Mutations have server-confirmed results, idempotency protection where
   applicable, and explicit confirmation for destructive or bulk actions.
5. Tests cover the owning transformation and at least one representative route
   failure; live Riot validation remains a named release gate.
6. Windows and macOS builds pass unless the feature is explicitly documented as
   platform-specific.
7. README, privacy notes, feature parity, and this roadmap are updated with the
   final status and evidence.

## Never add to RiftOps

- Entitlement, refund, champion, skin, Battle Pass, or ARAM boost exploits.
- Cooldown bypasses or hidden-mode forcing that the server does not support.
- Rank, mastery, challenge, banner, or profile spoofing presented as real data.
- Vanguard/stream-evasion, debugger injection, or IFEO functionality.
- Game-process injection, game-file modification, or minimap manipulation.
- Unrestricted LCU, Riot, RTMP, Store, Ledge, shell, filesystem, or process
  request consoles.
- Ranked lobby reveal, hidden-name restoration, or other deanonymization.
- Silent mass messages, friend mutations, loot actions, or reward claims.
- Account-email exposure without an explicit supported and user-authorized need.
- Phone access to credentials, session profiles, filesystem paths, diagnostics,
  companion administration, or unrestricted automation.

## Source notes

The feature lists above reflect the public READMEs and visible source of the
three repositories as reviewed on 2026-09-03. Their claims can change, and a
README entry is not proof that Riot currently supports the behavior. Every new
RiftOps feature should be validated against the current League Client API,
tested on a supported patch, and documented with its safety and phone-access
boundary.
