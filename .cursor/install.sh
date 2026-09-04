#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the TakeoffDetection monorepo.
# Prepares the three subprojects:
#   - DataCleaning  (FastAPI backend + Vite/React frontend)  -> primary web app
#   - TakeoffDetectionCollector/backend (Go library + unit tests)
#   - pipeline      (Python YOLO training / inference scripts)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GO_VERSION="1.23.12"

log() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
# System toolchain: Go 1.23 (the Collector module requires >= go 1.23) and the
# python venv module (the default image ships python3.12 without ensurepip).
# ---------------------------------------------------------------------------
have_go_123() {
  command -v go >/dev/null 2>&1 || return 1
  go version | grep -Eq 'go1\.(2[3-9]|[3-9][0-9])'
}

if ! have_go_123; then
  log "Installing Go ${GO_VERSION}"
  curl -fsSLO "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
  sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
  sudo ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
  rm -f "go${GO_VERSION}.linux-amd64.tar.gz"
fi
go version

if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
  log "Installing python3-venv"
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3.12-venv
fi

# ---------------------------------------------------------------------------
# DataCleaning backend (FastAPI + PyMuPDF). pytest/httpx are dev-only test
# tooling that the shipped test files import but requirements.txt omits.
# ---------------------------------------------------------------------------
log "DataCleaning backend"
cd "$ROOT/DataCleaning/backend"
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt
./.venv/bin/pip install -q pytest httpx

# ---------------------------------------------------------------------------
# DataCleaning frontend (Vite + React + PDF.js)
# ---------------------------------------------------------------------------
log "DataCleaning frontend"
cd "$ROOT/DataCleaning/frontend"
npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# Collector Go backend. go.sum is not committed, so generate it (this pins the
# already-declared dependency; it does not upgrade anything).
# ---------------------------------------------------------------------------
log "Collector Go backend"
cd "$ROOT/TakeoffDetectionCollector/backend"
go mod download
go mod tidy

# ---------------------------------------------------------------------------
# pipeline (YOLO train / infer scripts). Heavy deps (torch/ultralytics); kept
# in its own venv. Skippable with SKIP_PIPELINE=1 for faster iteration.
# ---------------------------------------------------------------------------
if [ "${SKIP_PIPELINE:-0}" != "1" ]; then
  log "pipeline"
  cd "$ROOT/pipeline"
  [ -d .venv ] || python3 -m venv .venv
  ./.venv/bin/pip install -q --upgrade pip
  ./.venv/bin/pip install -q -r requirements.txt
fi

log "Bootstrap complete"
