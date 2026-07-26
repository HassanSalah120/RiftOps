#!/usr/bin/env bash
set -euo pipefail

export PATH="$PATH:$HOME/go/bin"

VERSION="${1:-2.4.0}"
OUTDIR="${OUTDIR:-dist}"
BINARY="${OUTDIR}/RiftOps.exe"

echo "==> RiftOps Production Build (v${VERSION})"
echo ""

# 1. Frontend
echo "==> [1/4] TypeScript check..."
cd cmd/riftops-ui/frontend
npx tsc --noEmit
echo "  ✓ 0 errors"

echo "==> [2/4] Vite build..."
npx vite build
cd ../../..
echo "  ✓ frontend bundled"

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
LDFLAGS="-s -w -H windowsgui -X main.version=${VERSION}"
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
import struct
with open('dist/RiftOps.exe','rb') as f:
    d=f.read()
    off=struct.unpack_from('<I',d,0x3c)[0]
    subsys=struct.unpack_from('<H',d,off+24+68)[0]
    label = 'GUI' if subsys==2 else 'Console'
    print(f'  Subsystem: {subsys} ({label})')
    print(f'  Size: {len(d)} bytes ({len(d)/1024/1024:.1f}MB)')
    print(f'  .rsrc: {d.find(b".rsrc")!=-1}')
PYEOF
echo "  ✓ OK"
