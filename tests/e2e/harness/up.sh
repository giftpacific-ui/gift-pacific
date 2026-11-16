#!/usr/bin/env bash
# Reference harness used for the Phase 11 verification (sandbox paths: adapt before use). Starts PostgreSQL + the app.
PGB=/usr/lib/postgresql/16/bin
ps aux | grep -E "next start|next-server|next/dist/bin/next" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null; sleep 1
su postgres -c "$PGB/pg_ctl -D /tmp/pgdata -o '-p 5544 -k /tmp' -l /tmp/pg.log -w start" >/dev/null 2>&1
cd /home/claude/smoke4; source /tmp/env.sh
export CLOUDINARY_CLOUD_NAME=demo CLOUDINARY_API_KEY=111111111111111 CLOUDINARY_API_SECRET=fake-secret-for-e2e-only CLOUDINARY_URL='cloudinary://111111111111111:fake-secret-for-e2e-only@demo?upload_prefix=http://localhost:3999'
export DATABASE_URL="postgresql://postgres@localhost:5544/${DBNAME:-gp_e2e}" AUTH_SECRET=dev-only-secret-not-used-0123456789abcdef NEXT_PUBLIC_APP_URL=http://localhost:3400 NEXT_TELEMETRY_DISABLED=1
setsid nohup node node_modules/next/dist/bin/next start -p 3400 > /tmp/start4.log 2>&1 < /dev/null &
for i in $(seq 1 30); do sleep 1; curl -s -o /dev/null -m 3 http://localhost:3400/ && break; done
