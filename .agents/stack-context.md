# Stack Context

Generated: 2026-09-03

## Stack
- **Language**: Go 1.26.6
- **Framework**: Fyne desktop shell with embedded React/Vite UI
- **Build**: Go toolchain, Vite, PowerShell/Bash release scripts
- **Test**: `go test -race -tags desktop ./...`; frontend Node test runner
- **Lint**: oxlint (frontend release/CI gate)
- **Format**: gofmt; TypeScript compiler via Vite build

## Secondary Languages
- TypeScript/React (embedded dashboard UI)
- CSS/Tailwind (UI styling)

## Conventions
- Error handling: returned Go errors; HTTP handlers map errors to status codes
- Module structure: internal capability packages with `cmd/riftops-ui` coordinator
- Naming: Go package/file conventions; React feature components
- Tests: package-local `_test.go` and frontend `tests/*.test.ts`

## CI Gates
- Frontend lint and build
- Go race tests with `desktop` tag
- Windows/macOS release workflows
