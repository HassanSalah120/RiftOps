#!/usr/bin/env bash
set -euo pipefail

version="${1:-2.3.7}"
build="${2:-1}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

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

echo "[1/5] Building the embedded frontend..."
pushd cmd/riftops-ui/frontend >/dev/null
npm ci
npm run build
popd >/dev/null

echo "[2/5] Running tests..."
go test ./...
echo "[3/5] Running go vet..."
go vet ./...
echo "[4/5] Packaging the macOS app..."
fyne package --os darwin --src cmd/riftops-ui --release --tags desktop \
  --name RiftOps --app-id io.github.hassansalah120.riftops --app-version "$version" \
  --app-build "$build" --icon "$root/assets/riftops.png"

# GitHub-hosted runners do not have a Developer ID certificate. Ad-hoc signing
# still gives the archive a valid local code signature and prevents macOS from
# treating a modified/unsigned app bundle as damaged. A public release still
# needs Developer ID signing and notarization for seamless Gatekeeper approval.
codesign --force --deep --sign - RiftOps.app
codesign --verify --deep --strict --verbose=2 RiftOps.app

mkdir -p dist
rm -f dist/RiftOps-macOS.zip
echo "[5/5] Creating the release archive..."
ditto -c -k --sequesterRsrc --keepParent RiftOps.app dist/RiftOps-macOS.zip
echo "Created dist/RiftOps-macOS.zip"
