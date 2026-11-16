# Phase 11 verification harness (E2E, accessibility, load)

These scripts are **not part of `pnpm test`** (the test globs only cover `tests/unit`, `tests/services`, `tests/integration`) and add **no project dependencies**. They are the exact scripts used for the Phase 11 pass; paths such as `/tmp` and `/home/claude` are sandbox-specific and must be adapted.

## What they need (install outside the project, e.g. `npm i --no-save` in a scratch folder)
`puppeteer-core`, `@sparticuz/chromium` (a Chromium build bundled in an npm package), `axe-core`, `autocannon`; Node 22; PostgreSQL 16 (disposable); `pnpm` 11 for the app.

## Safety
* Run only against a **disposable database and a scratch copy of the app**. `seed-e2e.ts.txt` inserts synthetic data and users with a known test password.
* Cloudinary is **mocked** (`mock-cloudinary.mjs`): the browser's requests to `api.cloudinary.com` are intercepted, and the server-side SDK is pointed at a local mock through `CLOUDINARY_URL=...?upload_prefix=http://localhost:3999`. **These runs never talk to real Cloudinary and prove nothing about your real account or its limits.**
* No real payment, courier, email/SMS or webhook is ever called; orders are placed with COD in the scratch database only.
* The scratch copy needs two patches that must **never** be applied to the real project (see `harness/sync-scratch-copy.sh`): engine-free Prisma through `@prisma/adapter-pg` (because the sandbox could not download Prisma's engine) and stubbed Google fonts (because the sandbox has no internet). A build of that copy is a *verification build*, not a genuine build.

## Order of use
1. `harness/make-test-files.py` (test images). 2. `harness/mkdb.sh gp_e2e` then seed (`seed-e2e.ts.txt`). 3. `harness/sync-scratch-copy.sh`, build the scratch copy, `harness/up.sh` (starts `next start` on :3400). 4. Put minted session tokens in `/tmp/tokens4.txt` (`ADMIN_TOKEN=`/`CUST_TOKEN=`; HS256 JWT signed with the scratch `AUTH_SECRET`, with a long expiry). 5. `node customer.mjs`, `node admin.mjs`, `node product.mjs`, `node responsive.mjs public|cust|admin`, `node keyboard.mjs`, `node load.mjs <connections> <seconds> <paths...>`.

## Known limits of these scripts
Chromium only (the bundled build runs single-process, so no incognito contexts); no Firefox/WebKit/Edge. Chunk signatures are verified only for single-request uploads (bodies of chunked uploads are too large to inspect). Load numbers come from one shared machine and are only meaningful relative to each other.
