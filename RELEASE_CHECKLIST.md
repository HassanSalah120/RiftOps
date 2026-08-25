# RiftOps release checklist

Use this checklist for a public release. The repository CI verifies source and
test gates; the remaining items require the target operating systems and a real
League Client.

## Automated gates

- [ ] `npm ci --ignore-scripts` in `cmd/riftops-ui/frontend`
- [ ] `npm run lint`
- [ ] `npm test` (all frontend tests)
- [ ] `npm run build`
- [ ] `go test -race -tags desktop ./...`
- [ ] `go vet -tags desktop ./...`
- [ ] `git diff --check`

## Packaging

1. Confirm the intended version in [`VERSION`](VERSION).
2. Windows: install MinGW-w64 and Fyne, then run
   `./scripts/build-windows.ps1 -Build <build>`.
3. macOS: install Xcode command-line tools and Fyne, then run
   `bash ./scripts/build-macos.sh`.
4. Confirm each artifact has a matching `.sha256` file and verify the hash on a
   separate machine before uploading it to the GitHub Release.
5. Attach Windows and macOS artifacts to the same release tag. Do not claim
   macOS Gatekeeper compatibility until Developer ID signing and notarization
   have completed.

## Runtime acceptance

- [ ] Clean Windows startup has no console window and works with League outside
      the Riot Client directory.
- [ ] Clean macOS startup opens `RiftOps.app`; the app is signed/notarized for
      the intended distribution channel.
- [ ] League Client discovery, launch, lockfile refresh, friend list, and LCU
      phase transitions work on a real account.
- [ ] Champion Select hover/pick/ban, fallback policy, runes, custom/practice
      start, quit, and post-game actions are phase-valid and acknowledged.
- [ ] Phone QR pairing is one-use, expiring, revocable, LAN-only, and cannot
      reach desktop-only routes.
- [ ] The phone is tested on the same trusted private network; never expose
      the HTTP listener to the public internet.

## Explicit external gate

The chat proxy still uses the inherited Deceive-compatible loopback hostname
and certificate endpoint. Keep those values until RiftOps owns a domain that
resolves to loopback and a trusted matching certificate. Replacing the hostname
with `localhost` is not a valid release fix because Riot validates the expected
TLS name.
