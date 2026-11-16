#!/usr/bin/env bash
# Creates a disposable database and applies the repository's migrations in order. usage: mkdb.sh <dbname> [number_of_migrations]
# usage: mkdb.sh <dbname> [upto_migration_prefix_count]
PGB=/usr/lib/postgresql/16/bin; DB=$1
su postgres -c "$PGB/pg_ctl -D /tmp/pgdata -o '-p 5544 -k /tmp' -l /tmp/pg.log -w start" >/dev/null 2>&1
su postgres -c "psql -h /tmp -p 5544 -qc 'DROP DATABASE IF EXISTS $DB' -c 'CREATE DATABASE $DB'" 2>&1 | grep -v NOTICE
n=0; for d in $(ls /home/claude/gp4/prisma/migrations | grep -E '^[0-9]{14}_' | sort | head -${2:-100}); do
  su postgres -c "psql -h /tmp -p 5544 -d $DB -q -v ON_ERROR_STOP=1 -f /home/claude/gp4/prisma/migrations/$d/migration.sql" >/dev/null 2>/tmp/mig.err || { echo "FAILED $d"; head -3 /tmp/mig.err; exit 1; }; n=$((n+1)); done
echo "$DB: applied $n migrations"
