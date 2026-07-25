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

go test ./...
go vet ./...
fyne package --os darwin --src cmd/riftops-ui --release --tags desktop \
  --name RiftOps --app-id io.github.hassansalah120.riftops --app-version "$version" \
  --app-build "$build" --icon "$root/assets/riftops.png"

mkdir -p dist
rm -f dist/RiftOps-macOS.zip
ditto -c -k --sequesterRsrc --keepParent RiftOps.app dist/RiftOps-macOS.zip
echo "Created dist/RiftOps-macOS.zip"
