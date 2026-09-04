#!/usr/bin/env bash
# Per-boot startup: bring up the local Postgres server for the Collector.
# Idempotent — safe to run again if the server is already up. Dependency
# installation and schema creation live in .cursor/install.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/.cursor/pg-env.sh"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "postgres cluster missing at $PGDATA; run .cursor/install.sh first" >&2
  exit 1
fi

if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "postgres already running on port $PGPORT"
else
  "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp" -l "$HOME/pg.log" -w start
fi

# Apply the schema idempotently (create table if not exists) in case the data
# directory predates a migration change.
"$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/TakeoffDetectionCollector/supabase/migrations/001_init.sql" >/dev/null

echo "postgres ready: $COLLECTOR_DB_URL"
