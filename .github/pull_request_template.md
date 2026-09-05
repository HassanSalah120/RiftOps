## Description
<!-- Provide a clear and concise summary of the changes introduced in this pull request. -->

## Related Issue
<!-- Link any relevant issues, e.g. Fixes #123 -->

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] UI / UX enhancement
- [ ] Refactoring or performance optimization
- [ ] Documentation update

## Ban-Safety & Architecture Checklist
- [ ] **Zero Memory Hooking**: Change does not read or write `League of Legends.exe` process memory.
- [ ] **Zero In-Game Overlays**: Does not hook DirectX, Vulkan, or graphics swapchains.
- [ ] **Official LCU Only**: Interacts exclusively with local Riot HTTP/WebSocket APIs on localhost.
- [ ] **Zero Cloud Telemetry**: Does not transmit summoner identities, credentials, or telemetry to external servers.

## Testing & Verification
- [ ] Go tests pass: `go test ./...`
- [ ] Frontend tests pass: `npm test` (inside `cmd/riftops-ui/frontend`)
- [ ] Verified on local desktop window
