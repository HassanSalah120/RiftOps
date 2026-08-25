#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:-$(tr -d '\r\n' < "$root/VERSION")}"
build="${2:-1}"
cd "$root"

if [[ -z "$version" ]]; then
  echo "VERSION is empty. Pass a version explicitly." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This packaging script must run on macOS." >&2
  exit 1
fi
if ! command -v fyne >/dev/null 2>&1; then
  echo "Fyne CLI not found. Run: go install fyne.io/tools/cmd/fyne@v1.7.2" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build the embedded dashboard." >&2
  exit 1
fi

echo "[1/8] Installing the locked frontend dependencies..."
pushd cmd/riftops-ui/frontend >/dev/null
npm ci --ignore-scripts
echo "[2/8] Linting and testing the frontend..."
npm run lint
npm test
echo "[3/8] Building the embedded frontend..."
npm run build
popd >/dev/null

echo "[4/8] Running race-enabled desktop tests..."
go test -race -tags desktop ./...
echo "[5/8] Running go vet..."
go vet -tags desktop ./...
echo "[6/8] Packaging the macOS app..."
fyne package --os darwin --src cmd/riftops-ui --release --tags desktop \
  --name RiftOps --app-id io.github.hassansalah120.riftops --app-version "$version" \
  --app-build "$build" --icon "$root/cmd/riftops-ui/app.png"

# GitHub-hosted runners do not have a Developer ID certificate. Ad-hoc signing
# still gives the archive a valid local code signature and prevents macOS from
# treating a modified/unsigned app bundle as damaged. A public release still
# needs Developer ID signing and notarization for seamless Gatekeeper approval.
codesign --force --deep --sign - RiftOps.app
codesign --verify --deep --strict --verbose=2 RiftOps.app

mkdir -p dist
rm -f dist/RiftOps-macOS.zip
echo "[7/8] Creating the release archive..."
ditto -c -k --sequesterRsrc --keepParent RiftOps.app dist/RiftOps-macOS.zip
echo "[8/8] Writing SHA-256 checksum..."
(cd dist && shasum -a 256 RiftOps-macOS.zip > RiftOps-macOS.zip.sha256)
echo "Created dist/RiftOps-macOS.zip and dist/RiftOps-macOS.zip.sha256"
