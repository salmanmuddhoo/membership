#!/usr/bin/env bash
# Start a local PostgreSQL cluster for development and tests.
#
# This mirrors the deployed setup rather than being a convenient shortcut: a
# superuser that owns the schema and runs migrations, and a least-privilege
# application role with no DDL rights that the app connects as. Code that
# accidentally depends on the app being able to change the schema therefore
# fails here, not in Azure.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/lib/postgresql/m1dev}"
PORT="${PORT:-5433}"

if [ ! -d "$PGDATA/base" ]; then
  install -d -o postgres -g postgres -m 700 "$PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA -A trust -U postgres"
fi

# Already-running is not an error.
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k /tmp' -l $PGDATA.log start" || true

psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE albarakah'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'albarakah')\gexec
SQL

psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'albarakah_app') THEN
    -- Local development only. Deployed environments take their password from
    -- the environment and never from a file in the repository.
    CREATE ROLE albarakah_app WITH LOGIN PASSWORD 'devpassword';
  END IF;
END
$$;
SQL

psql -h 127.0.0.1 -p "$PORT" -U postgres -d albarakah -v ON_ERROR_STOP=1 <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE albarakah TO albarakah_app;
GRANT USAGE ON SCHEMA public TO albarakah_app;
SQL

echo "Local database ready on port $PORT."
echo "DATABASE_URL=postgresql://albarakah_app:devpassword@127.0.0.1:$PORT/albarakah"
