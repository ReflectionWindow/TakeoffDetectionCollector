# Shared Postgres settings for the self-contained Collector database.
# Sourced by .cursor/install.sh and .cursor/start.sh.
PGDATA="${PGDATA:-$HOME/pgdata}"
PGPORT="${PGPORT:-5433}"
PGUSER_DB="collector"
PGUSER="collector"
PGPASSWORD_DB="collector"
PGPASSWORD="collector"
PGDB="collector"

# Locate the PostgreSQL 16 binaries (Debian/Ubuntu layout).
if [ -d /usr/lib/postgresql ]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"

# Connection string the Collector backend uses (over TCP, matching production).
COLLECTOR_DB_URL="postgres://collector:collector@127.0.0.1:${PGPORT}/collector?sslmode=disable"
export PGDATA PGPORT PGBIN PGDB PGUSER PGPASSWORD COLLECTOR_DB_URL
