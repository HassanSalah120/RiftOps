#!/usr/bin/env bash
set -euo pipefail

export PATH="$PATH:$HOME/go/bin"

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-$(tr -d '\r\n' < "$ROOT/VERSION" 2>/dev/null || echo 2.7.7)}"
OUTDIR="${OUTDIR:-$ROOT/dist}"
export OUTDIR
BINARY="${OUTDIR}/RiftOps.exe"

echo "==> RiftOps Production Build (v${VERSION})"
echo ""

# 1. Frontend
cd "$ROOT"
echo "==> [1/4] TypeScript check..."
cd cmd/riftops-ui/frontend
npx tsc --noEmit
echo "  ✓ 0 errors"

echo "==> [2/4] Vite build..."
npx vite build
cd ../../..
echo "  ✓ frontend bundled"

echo "==> [2.5/4] Frontend lint and tests..."
cd cmd/riftops-ui/frontend
npm run lint
npm test
cd ../../..
echo "  ✓ frontend checks"

echo "==> [2.75/4] Go race tests and vet..."
go test -race -tags desktop ./...
go vet -tags desktop ./...
echo "  ✓ Go checks"

# 2. Resources
echo "==> [3/4] PE resources (icon, manifest, version)..."
go-winres simply \
    --icon cmd/riftops-ui/app.ico \
    --manifest gui \
    --product-version "$VERSION" \
    --file-version "$VERSION" \
    --product-name "RiftOps" \
    --file-description "Private Riot Client with Presence Masking" \
    --original-filename "RiftOps.exe" \
    --arch amd64
echo "  ✓ rsrc_windows_amd64.sygo"

# 3. Go build
echo "==> [4/4] Go build (trimpath, stripped, GUI)..."
LDFLAGS="-s -w -H windowsgui -X github.com/HassanSalah120/RiftOps/internal/buildinfo.Version=${VERSION}"
mkdir -p "${OUTDIR}"
go build \
    -trimpath \
    -ldflags="${LDFLAGS}" \
    -o "${BINARY}" \
    ./cmd/riftops-ui/
echo "  ✓ ${BINARY}"

# 4. Verify
echo ""
echo "==> Verify:"
go version -m "${BINARY}" | head -2
python << 'PYEOF'
import os
import struct
with open(os.path.join(os.environ['OUTDIR'], 'RiftOps.exe'), 'rb') as f:
    d=f.read()
    off=struct.unpack_from('<I',d,0x3c)[0]
    subsys=struct.unpack_from('<H',d,off+24+68)[0]
    label = 'GUI' if subsys==2 else 'Console'
    print(f'  Subsystem: {subsys} ({label})')
    print(f'  Size: {len(d)} bytes ({len(d)/1024/1024:.1f}MB)')
    print(f'  .rsrc: {d.find(b".rsrc")!=-1}')
PYEOF
echo "  ✓ OK"
