#!/usr/bin/env bash
# Builds the SCRATCH verification copy (engine-free Prisma through the pg driver adapter + stubbed Google fonts). Never used for the real build.
# Rebuild the SCRATCH verification copy from the deliverable tree (never shipped). Patches: engine-free Prisma via pg adapter; stubbed Google fonts.
set -e
SM=/home/claude/smoke4
mkdir -p $SM
[ -d $SM/node_modules ] || { [ -d /home/claude/smoke/node_modules ] && mv /home/claude/smoke/node_modules $SM/node_modules; }
rm -rf $SM/src $SM/tests $SM/prisma/migrations
cd /home/claude/gp4 && tar --exclude=./node_modules --exclude=./.next -cf - . | (cd $SM && tar xf -)
cd $SM
python3 - <<'PY'
import re
p="prisma/schema.prisma"; t=open(p).read()
if "engineType" not in t: t=t.replace('provider = "prisma-client-js"\n','provider = "prisma-client-js"\n  engineType = "client"\n',1)
open(p,"w").write(t)
p="src/lib/db/prisma.ts"; t=open(p).read()
t=t.replace('import { PrismaClient } from "@prisma/client";','import { PrismaClient } from "@prisma/client";\nimport { PrismaPg } from "@prisma/adapter-pg";',1)
t=t.replace('new PrismaClient({','new PrismaClient({\n    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),',1)
open(p,"w").write(t)
p="src/app/layout.tsx"; t=open(p).read()
t=re.sub(r'import \{\s*Cormorant,\s*Manrope,\s*Noto_Serif_Bengali,\s*\} from "next/font/google";','const Cormorant = (o: Record<string, unknown>) => ({ variable: String(o.variable), className: "" });\nconst Manrope = Cormorant; const Noto_Serif_Bengali = Cormorant;',t)
open(p,"w").write(t)
PY
echo "scratch copy synced + patched"
