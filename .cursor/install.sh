#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the TakeoffDetection monorepo.
#   - TakeoffDetectionCollector (Go API + Postgres + React)   -> primary app
#   - DataCleaning              (FastAPI + Vite/React)         -> snap annotator
#   - pipeline                  (Python YOLO train / infer scripts)
# Durable setup only. Per-boot service startup lives in .cursor/start.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=/dev/null
source "$ROOT/.cursor/pg-env.sh"

GO_VERSION="1.23.12"

log() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
# System toolchain: Go 1.23 (the Collector module requires >= go 1.23), the
# python venv module, and PostgreSQL 16 (durable store for the Collector).
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

APT_PKGS=()
python3 -c "import ensurepip" >/dev/null 2>&1 || APT_PKGS+=(python3.12-venv)
[ -x "$PGBIN/initdb" ] || APT_PKGS+=(postgresql postgresql-client)
if [ "${#APT_PKGS[@]}" -gt 0 ]; then
  log "Installing system packages: ${APT_PKGS[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${APT_PKGS[@]}"
fi

# ---------------------------------------------------------------------------
# Local Postgres cluster (self-contained under $HOME, no systemd needed).
# Creates the cluster, role, database and schema once; the server itself is
# started per-boot by .cursor/start.sh.
# ---------------------------------------------------------------------------
log "PostgreSQL cluster"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/tmp/initdb.log 2>&1
fi
pg_running() { "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }
started_here=0
if ! pg_running; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp" -l "$HOME/pg.log" -w start
  started_here=1
fi
"$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -tc "select 1 from pg_roles where rolname='$PGUSER'" | grep -q 1 \
  || "$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -c "create role $PGUSER login password '$PGPASSWORD'"
"$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -tc "select 1 from pg_database where datname='$PGDB'" | grep -q 1 \
  || "$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -c "create database $PGDB owner $PGUSER"
"$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/TakeoffDetectionCollector/supabase/migrations/001_init.sql" >/dev/null
"$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
alter schema public owner to $PGUSER;
grant all on all tables in schema public to $PGUSER;
grant all on all sequences in schema public to $PGUSER;
alter default privileges in schema public grant all on tables to $PGUSER;
SQL
[ "$started_here" = "1" ] && "$PGBIN/pg_ctl" -D "$PGDATA" -w stop >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Collector backend (Go) — generate go.sum (not committed) and build.
# ---------------------------------------------------------------------------
log "Collector backend (Go)"
cd "$ROOT/TakeoffDetectionCollector/backend"
go mod download
go mod tidy
go build ./...

# ---------------------------------------------------------------------------
# Collector frontend (Vite + React + PDF.js)
# ---------------------------------------------------------------------------
log "Collector frontend"
cd "$ROOT/TakeoffDetectionCollector/frontend"
npm ci --no-audit --no-fund

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
