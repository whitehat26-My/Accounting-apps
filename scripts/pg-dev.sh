#!/usr/bin/env bash
#
# Local PostgreSQL for development and integration tests.
#
# Testcontainers is the intended tool in CI, but it needs a Docker daemon. This
# script gives the same thing from a plain PostgreSQL 16 install, which is what
# is actually available in a lot of sandboxes and CI images.
#
#   ./scripts/pg-dev.sh start|stop|status|psql
#
set -euo pipefail

PGPORT="${EMIL_PGPORT:-55432}"
PGDATA="${EMIL_PGDATA:-/tmp/emil-pgdata}"
PGSOCK="${EMIL_PGSOCK:-/tmp/emil-pgsock}"
PGBIN="${EMIL_PGBIN:-/usr/lib/postgresql/16/bin}"
PGUSER_OS="${EMIL_PGUSER_OS:-postgres}"

export PATH="$PGBIN:$PATH"

# initdb refuses to run as root, so drop to an unprivileged account when needed.
run_as_pg() {
    if [ "$(id -u)" -eq 0 ]; then
        su "$PGUSER_OS" -c "PATH=$PGBIN:\$PATH $1"
    else
        bash -c "$1"
    fi
}

start() {
    if [ ! -d "$PGDATA/base" ]; then
        echo "Initialising cluster at $PGDATA"
        mkdir -p "$PGDATA" "$PGSOCK"
        if [ "$(id -u)" -eq 0 ]; then
            chown -R "$PGUSER_OS":"$PGUSER_OS" "$PGDATA" "$PGSOCK"
        fi
        run_as_pg "initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
    fi

    if pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
        echo "Already running on port $PGPORT"
    else
        run_as_pg "pg_ctl -D $PGDATA -o '-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1' -l /tmp/emil-pg.log start" >/dev/null
        for _ in $(seq 1 20); do
            pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 && break
            sleep 0.5
        done
    fi

    echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PGPORT/postgres"
}

case "${1:-start}" in
    start)  start ;;
    stop)   run_as_pg "pg_ctl -D $PGDATA stop -m fast" >/dev/null && echo "Stopped" ;;
    status) pg_isready -h 127.0.0.1 -p "$PGPORT" ;;
    psql)   psql "postgres://postgres@127.0.0.1:$PGPORT/postgres" ;;
    *)      echo "usage: $0 start|stop|status|psql" >&2; exit 1 ;;
esac
