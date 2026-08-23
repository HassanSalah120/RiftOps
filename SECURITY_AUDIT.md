# RiftOps Remote Access Security Audit

Date: 2026-08-23
Scope: the optional private-LAN HTTP listener, QR pairing, phone sessions,
remote endpoint authorization, browser-origin protections, request limits, and
the React pairing UI.

## Executive summary

The audit found two high-severity design issues in the initial implementation:
the QR secret was also the 24-hour session credential, and an authenticated
phone inherited the complete desktop HTTP mux. Both are fixed. Pairing is now a
five-minute single-use exchange for a separate eight-hour in-memory session,
and the remote listener enforces an explicit route-and-method allowlist. Device
sessions are visible and individually revocable from the desktop.

No Critical findings remain in the reviewed scope. One Medium residual risk is
accepted and clearly disclosed: phone traffic is HTTP on the local network and
therefore is not confidential against a hostile network participant.

Post-audit hardening replaced the broad flat allowlist with named phone
capabilities. Desktop settings, saved sessions, local paths, updates,
automation configuration, loot/crafting, rune CRUD, cosmetics, diagnostics,
engine start/stop, and app quit are now server-denied. The frontend consumes an
explicit device-mode bootstrap before rendering, and route-contract tests bind
the phone policy to the registered API inventory. API responses also carry CSP,
frame, referrer, permissions, opener, and no-store protections.

## Findings

### RA-001 — QR secret reused as a long-lived bearer session

- Severity: High (fixed)
- Rule: GO-AUTH-SESSION-001 / secure session lifecycle
- Location: `cmd/riftops-ui/remote_access.go:27`, `:201`, `:291`
- Evidence: The previous code set the QR token directly as the cookie and kept
  it valid for 24 hours. The current code consumes the pairing token once,
  clears it, and creates an independent random session credential.
- Impact: Anyone who photographed or recovered a pairing URL could repeatedly
  pair until expiry and use the same bearer secret as an authenticated session.
- Fix: Five-minute, single-use pair tokens; separate 256-bit random session
  tokens; only SHA-256 token keys stored in memory; eight-hour absolute expiry.
- False-positive notes: None. The prior behavior was covered by tests but the
  test confirmed reuse rather than preventing it.

### RA-002 — Paired phone inherited the desktop route table

- Severity: High (fixed)
- Rule: GO-AUTHZ-001 / deny by default and authorize every operation
- Location: `cmd/riftops-ui/remote_access.go:326-368`
- Evidence: The previous guard forwarded authenticated requests to the entire
  desktop mux, including filesystem browsing, credential-session operations,
  diagnostics, updates, quit, and other desktop-only actions.
- Impact: A compromised phone session had materially more authority than the
  advertised mobile League workflow.
- Fix: Exact remote API allowlist with allowed HTTP methods. Static application
  files and read-only LCU game assets remain available; all unknown API routes
  fail closed with HTTP 403.
- Mitigation: New phone features must be added to the allowlist deliberately
  and should receive an authorization test.

### RA-003 — No device inventory or targeted revocation

- Severity: Medium (fixed)
- Rule: GO-AUTH-SESSION-002 / revocation and session visibility
- Location: `cmd/riftops-ui/remote_access.go:244-282`, `:433-475`
- Evidence: The previous design had one global token and could only rotate it.
- Impact: Users could not identify or disconnect one lost/unknown phone without
  invalidating every device.
- Fix: Random public device IDs, creation/last-seen/expiry metadata, individual
  revoke, revoke-all, automatic expiry cleanup, and shutdown revocation. User
  agents are display labels only and are never trusted as identity.

### RA-004 — Cross-origin mutation and request-exhaustion protections incomplete

- Severity: Medium (fixed)
- Rule: GO-HTTP-ORIGIN-001 / GO-HTTP-LIMITS-001
- Location: `cmd/riftops-ui/main.go:144-164`, `cmd/riftops-ui/remote_access.go:108-113`, `:371-381`
- Evidence: The previous remote path accepted unsafe requests with no Origin,
  compared only authority when Origin existed, lacked general body caps, and
  returned few browser security headers.
- Impact: Browser-driven cross-site requests and oversized/slow requests had a
  larger opportunity to consume or misuse the LAN service.
- Fix: Unsafe remote methods require exact HTTP same-origin; remote bodies are
  capped at 1 MiB (management bodies at 4 KiB); header/read/idle timeouts and
  header limits are configured; CSP, frame denial, MIME sniffing prevention,
  and no-referrer headers are set. Wildcard SSE CORS was removed. The CSP
  permits only Riot Data Dragon and CommunityDragon read-only asset hosts so
  the existing mobile League views can load their image fallbacks. The session
  cookie is `SameSite=Lax` to support QR navigation from mobile camera apps;
  same-origin enforcement remains the mutation protection.
- False-positive notes: Requests without an Origin are still allowed for GET
  and HEAD because QR handoff/navigation legitimately uses them.

### RA-005 — LAN traffic is not encrypted

- Severity: Medium (open, explicitly accepted for current LAN-first mode)
- Rule: GO-TRANSPORT-001 / protect credentials in transit
- Location: `cmd/riftops-ui/remote_access.go:106`,
  `cmd/riftops-ui/frontend/src/components/RemoteAccessCard.tsx`
- Evidence: The listener uses `http://<private-ip>` and the cookie cannot safely
  use the Secure attribute over plain HTTP.
- Impact: A hostile participant able to observe the local network may capture
  phone traffic or the session cookie. Authentication does not provide transport
  confidentiality.
- Mitigation: The feature is opt-in, binds one private interface, uses short
  in-memory sessions, warns in the UI and README, and must never be port-forwarded.
  A future version should use a trusted local certificate, mutually
  authenticated transport, or an encrypted relay/tunnel before claiming secure
  use on untrusted networks.

## Verification requirements

- Unit tests assert that QR tokens are single-use and distinct from sessions.
- Unit tests cover pair/session expiry and targeted revocation.
- Authorization tests prove representative desktop-only routes cannot reach the
  wrapped handler and champion-select mutations remain available.
- Origin tests require exact HTTP authority and reject HTTPS mismatch and
  lookalike hosts.
- Go tests/vet and frontend lint/tests/build must pass before release.

This report is source-level and automated-test based. It does not claim a live
network penetration test, firewall test, packet-capture test, or browser visual
test.
