VERSION ?= 2.3.7
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")

OUTDIR  ?= dist
BINARY  := $(OUTDIR)/RiftOps.exe

# ldflags: strip debug (-s -w), GUI subsystem, inject version
LDFLAGS := -s -w -H windowsgui
LDFLAGS += -X main.version=$(VERSION)

# Build flags for determinism
BUILDFLAGS := -trimpath -ldflags="$(LDFLAGS)"

.PHONY: all frontend resources clean

all: frontend resources binary

frontend:
	cd cmd/riftops-ui/frontend && npx tsc --noEmit
	cd cmd/riftops-ui/frontend && npx vite build

resources:
	go-winres simply \
		--icon cmd/riftops-ui/app.ico \
		--manifest gui \
		--product-version $(VERSION) \
		--file-version $(VERSION) \
		--product-name "RiftOps" \
		--file-description "Private Riot Client with Presence Masking" \
		--original-filename "RiftOps.exe" \
		--arch amd64

binary: | $(OUTDIR)
	go build $(BUILDFLAGS) -o "$(BINARY)" ./cmd/riftops-ui/
	@echo "--- $(BINARY) ---"
	@go version -m "$(BINARY)" | head -2
	@echo "Size: $$(wc -c < "$(BINARY)" | tr -d ' ') bytes"

$(OUTDIR):
	mkdir -p $(OUTDIR)

release: all

clean:
	rm -rf $(OUTDIR)
	rm -f cmd/riftops-ui/rsrc_windows_amd64.sygo
	rm -rf cmd/riftops-ui/frontend/dist
