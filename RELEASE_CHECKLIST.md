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
5. (Optional while the SignPath application is pending.) Configure SignPath
   Foundation before publishing signed Windows releases:
   - GitHub Actions secret: `SIGNPATH_API_TOKEN`.
   - Repository variables: `SIGNPATH_ORGANIZATION_ID`,
     `SIGNPATH_PROJECT_SLUG`, and `SIGNPATH_SIGNING_POLICY_SLUG`.
   Set the repository variable `SIGNPATH_ENABLED` to `true` only after the
   SignPath project is ready. With it unset or `false`, the workflow publishes
   an unsigned executable and does not require any SignPath credentials. When
   enabled, the workflow uploads the executable to SignPath's trusted GitHub
   build system, waits for the signing request, verifies the SignPath
   Authenticode subject, then regenerates the checksum.
6. Attach Windows and macOS artifacts to the same release tag. Do not claim
   macOS Gatekeeper compatibility until Developer ID signing and notarization
   have completed.

Windows portable artifacts use the release-facing name
`RiftOps-<version>-win-x64.exe`; do not rename the file after signing because
the checksum and Authenticode verification must describe the published bytes.

## Runtime acceptance

- [ ] Clean Windows startup has no console window and works with League outside
      the Riot Client directory.
- [ ] If SignPath is enabled, `Get-AuthenticodeSignature` reports `Valid` and
      the signer subject contains `SignPath Foundation` for the published
      Windows executable.
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

## Chat proxy acceptance

- [ ] Client config rewrites chat to `127.0.0.1` and enables Riot's local
      bad-certificate compatibility mode.
- [ ] RiftOps generates and caches a private certificate for `127.0.0.1`; no
      external DNS record or certificate download is required.
- [ ] Confirm chat, friends, lobby presence, and in-game notifications on a
      real League Client after a clean first start.
