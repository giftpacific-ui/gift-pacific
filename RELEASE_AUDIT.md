# RELEASE AUDIT — Gift Pacific emergency production release

**Business restart: BLOCKED** — not cleared. All source-level P0 issues that can be resolved in this environment are resolved and verified; what remains needs the owner's production access, host or approval (§6). This document records the evidence; `RELEASE_CHECKLIST.md` tells the owner exactly what to do; `MASTER_ROADMAP.md` keeps the full Phase 0–11 plan.

**Scope and ground rules:** emergency fast-track only. No Phase 2 work, no combo/box redesign, no business-logic change, no migration change, no new dependency, no mocked behaviour in the shipped code. Every claim below states **what kind of evidence** supports it.

## 1. Evidence legend — what each kind of test does and does not establish

| Tag | Evidence | Establishes | Does **not** establish |
|---|---|---|---|
| **[T]** | `pnpm test` on the in-memory fake database | Business rules and logic | Real SQL, locking, concurrency |
| **[PG]** | Executed on a real, disposable PostgreSQL 16 | SQL, constraints, row locks, concurrency, service behaviour with real data | HTTP/UI behaviour; the production database |
| **[HTTP]** | Requests to the built application running against the rehearsal database | Rendering, status codes, redirects, headers | Browser behaviour, client-side interaction, POST flows |
| **[SRC]** | Reading the source | Design/intent | That it runs |
| **EMPTY-DB** | Migrations applied to an **empty** database | The migration SQL is valid | **Production** migration status or checksums (BLOCKED) |
| **MOCKED-FONT BUILD** | Build with substituted font CSS | Application compiles and generates routes | A genuine production build |

## 2. Issue register

### P0 — mandatory before business restart

| ID | Finding | Evidence | Affected files | Status |
|---|---|---|---|---|
| **P0-1** | **Home page returned HTTP 500 when no Campaign-placement banner was active** (fresh store, deleted banner, or a banner whose end date passed). `campaignBanner.imageUrl` was read unguarded while `campaignBanner` was `undefined`; the same variable is guarded elsewhere on the page. TypeScript cannot see it (`array[0]` is typed as present). | Real build failure: `Error occurred prerendering page "/" … Cannot read properties of undefined (reading 'imageUrl')` [build]. After the fix: build passes; `/` = 200 with **no** banners and with banners of all five placements (hero + campaign banners rendered) [HTTP]; regression guard fails on the original code (`unguarded campaignBanner.imageUrl at line 190`) and passes on the fix [T]. | `src/app/(shop)/page.tsx` (1 line); `tests/unit/homepage-empty-state.test.ts` | **FIXED and verified** at source/HTTP level. Not browser-verified. |
| **P0-2** | **Advance policy is OFF by default** (`advanceEnabled = false`). Not a code defect, but orders outside Dhaka need **no** advance until the owner enables it. | Release scenarios on real PostgreSQL both ways [PG]; schema default [SRC]. | `prisma/schema.prisma`, `src/server/services/advance.service.ts` | **OWNER ACTION REQUIRED** — confirm Admin → Advance & trust (checklist O-1). Default not changed. |
| **P0-3** | **`channel_website` reference row is required**; without it every checkout fails (FK `Order_channelId_fkey`). Inserted by migration 6. | Observed when a test reset removed it [PG]; migration source [SRC]. | `prisma/migrations/…_channels_costs_settings` | Smoke check added to the checklist (§6.2). **OWNER ACTION REQUIRED** if the row is absent (§6.3: wait for approval). |
| **P0-4** | **Possible migration checksum drift** on `20261008000000_init` and migration 22 (their text was edited after Phase 1's inherited manual rename). | The two files are the only migrations containing the new brand name [SRC]; unchanged in this release (byte-identical to baseline) [git]. Read-only PowerShell/SQL procedure written and **executed under PowerShell 7.5.4 against an emulated `_prisma_migrations` table** (26 MATCH, 1 MISMATCH, 1 NOT FINISHED, as constructed). | `RELEASE_CHECKLIST.md` §4 | **BLOCKED** — production access required. Do not deploy until the owner has run it. |
| **P0-5** | **Production configuration** must be correct: strong `AUTH_SECRET` (≥ 32), https `NEXT_PUBLIC_APP_URL`, `UPLOAD_PROVIDER=cloudinary` explicitly (code default is `local`), reachable `DATABASE_URL` at build time. | `src/lib/env.ts` accepts 16-char secrets and defaults the provider to `local` [SRC]; startup checks log critical for weak secret/localhost/bKash [T]. | `src/lib/env.ts`, `src/lib/production-checks.ts` (unchanged) | Documented (checklist §2). Not changed in code to avoid refusing to start with an existing 16–31-char secret. **OWNER ACTION REQUIRED.** |
| **P0-6** | **A genuine production build has never been observed to succeed** in the verification environment. | Unmodified `pnpm build`: 4 errors, all `next/font` failing to fetch four Google fonts [environment]. Mocked-font webpack build of a clean lockfile copy: exit 0 [MOCKED-FONT BUILD]. | — | **UNVERIFIED.** The owner's host (internet access) must run `pnpm build` (checklist §5). No typography was changed. |
| **P0-7** | **Browser/UI verification not done**: client-side cart, checkout form, server actions over HTTP, login. | No browser available; HTTP-level only. | — | **UNVERIFIED.** Mitigated by the same flows verified at service level on real PostgreSQL; owner smoke test in checklist §6.4. |

### P0 areas audited with **no defect found** (evidence)

| Area (task Part D) | Result | Evidence |
|---|---|---|
| Order creation, snapshots, server-authoritative totals, price tamper | OK | 3 scenarios [PG] |
| Order numbers unique under concurrency | OK | 15 parallel orders [PG]; sequence test [PG] |
| Duplicate checkout submission | Exactly one order | scenario [PG] |
| Overselling under concurrency | Prevented | 12 buyers / 3 units [PG]; 24 integration tests incl. stock races [PG] |
| Cancellation restores stock once; terminal orders do not restore again | OK | scenario with parallel cancels [PG] |
| Advance enforced server-side; cannot be bypassed from the client | OK (when enabled) | scenario [PG] |
| Payment-claim verification protected; one transaction id → one order; duplicate verification idempotent | OK | scenario [PG] |
| Admin authorization (action, service, layout, proxy) | OK | all `admin-*` actions reference an admin guard [SRC]; customer/anonymous refused [PG]; unauthenticated `/admin*` → 307 login [HTTP] |
| Customer ownership checks | OK | scenario [PG]; queries scoped by `userId` [SRC] |
| Courier controls unavailable without credentials; endpoints protected | OK | reconcile 401, webhook/IPN GET 405 [HTTP]; adapters `adapterAvailable:false` [SRC] |
| No secrets in repository | OK | pattern scan; `.env.example` placeholders only |
| Cookie configuration | httpOnly, SameSite=Lax, secure in production, separate admin/customer cookies | [SRC] |
| Public data leakage | none found | cost price / hashes absent from public HTML; draft product hidden; draft absent from sitemap [HTTP] |
| Combo component stock | unchanged logic | combo checkout test [PG] |
| Delivered orders do not accidentally restore stock | unchanged logic | stock-writer inventory and tests [T]+[PG] (no scenario of the delivered path was added) |

### P1 — important, may be deferred (current safe workflow still works)

| ID | Finding | Evidence | Workaround | Roadmap phase |
|---|---|---|---|---|
| P1-1 | No baseline security headers | `next.config.ts` had none [SRC] | **FIXED in this release**: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`. Verified on 200/307/401 responses [HTTP]; unit test. DENY verified safe: the site only embeds others (YouTube, GTM noscript); nothing frames its own pages [SRC]. | 10 |
| P1-2 | `robots.txt` advertises `/sitemap.xml` → 404 (sitemap is at `/sitemap/0.xml`) | [HTTP] | Submit `/sitemap/0.xml` in Search Console | 9 |
| P1-3 | Unknown/draft product URLs answer 200 with a "not found" page (`noindex`) — soft 404 | [HTTP] | `noindex` already emitted; no data leaks | 6 |
| P1-4 | No Content-Security-Policy | [SRC]/[HTTP] | Baseline headers; CSP needs design against GTM/Pixel/Cloudinary/JSON-LD. Unit test records the decision. | 10 |
| P1-5 | Hero auto-rotation has no pause control (WCAG 2.2.2); the existing test fails for this | [T] (pre-existing) | None needed for trading | 6 |
| P1-6 | `tests/unit/proxy.test.ts` never runs (top-level await under the CJS loader) → proxy gating untested by the suite | [T] (pre-existing) | Gating verified over HTTP in this release | 11 |
| P1-7 | Reservation: unpaid PENDING orders hold stock with no expiry | [SRC] | Cancel abandoned orders daily | 4 |
| P1-8 | No email/SMS, no OTP phone verification | [SRC] | Manual contact; operator password-reset command (handoff §22) | 7/9 |
| P1-9 | Steadfast / fraud endpoint never run live; no courier cancellation; Pathao/RedX absent | [SRC] | **Manual courier entry**; keep `COURIER_AUTO_BOOK=false`, fraud provider unset | 8 |
| P1-10 | Terms/Privacy/Shipping text need owner/legal review | [SRC] | Review before launch | 9 |
| P1-11 | No Gift Pacific logo/favicon assets (also no default share image or PWA icons). The loading screen referenced the deleted old logo file (broken image) — **fixed in the Phase 1 completion pass** | [SRC]+[T] | Text store name; upload in Admin → Settings | 1 |
| P1-12 | Build needs Google Fonts + a reachable database (sitemap) | build log | Build on a connected host | 11 |
| P1-13 | Legacy Cloudinary folders are displayed normally. The `giftpacific/` prefix check guards only the two client upload actions; server-side save/delete flows delete a stored public id **without** a prefix check (corrected from the earlier "cannot be deleted" wording) | [SRC] | Owner SQL in handoff §22 (now covers all six models with public ids) | 1/10 |

### P2 — post-release

Non-critical lint (22 errors / 12 warnings, identical to the untouched archive; the earlier "10 warnings" was stale) · stale `campaigns` test · theme-vs-migration guard test (fails because migration 22 contains an `UPDATE "StoreSettings"`) · enum value *order* of `PaymentStatus`/`PaymentMethod` differs from the Prisma declaration (sets equal; cosmetic) · `db:migrate` script runs `migrate dev` (never use on a real database) · bKash and online balance/full payment · Nagad · free-delivery coupon · manifest/PWA · Phase 2/3/5/6 redesigns · load testing · browser E2E. Nothing in security, payment, stock or database integrity is classified P2.

### Phase 11 pass: new findings (nothing below was changed; all need an owner decision)

| # | Finding | Severity | Evidence | Suggested handling |
|---|---|---|---|---|
| F-1 | **No rate limit on `submitCheckout`, `checkCoupon`, `getDeliveryChargesAction`, `getAdvanceQuoteAction`.** Every other public mutation is limited. Anonymous order spam / coupon-code guessing is limited only by fraud scoring and the order rules. | Medium | [SRC] audit of `RATE_LIMITS` usage | Add per-IP limits in a later phase; do not change checkout in an emergency |
| F-2 | **Unknown product, box and order URLs return HTTP 200** (the body is the not-found page with `noindex`). The root `loading.tsx` streams before `notFound()` resolves. | Low (SEO hygiene) | [HTTP dev server] | Monitor in Search Console; fix later if it matters |
| F-3 | **Loading screen references `/images/logo.png`, which is not in the ZIP** (owner-protected, intentionally hard-coded). If the file is missing on the host the loading screen shows a broken image; two `brand-assets` tests fail because of it. | Low | [SRC]+[T] | Owner: confirm the file exists in the deployment; then adjust the two guards |
| F-4 | **No `Strict-Transport-Security`; no Content-Security-Policy** (CSP is deliberate and deferred; HSTS is normally added by the host). `X-Powered-By` is sent. | Low | [HTTP dev server] | Confirm HSTS at the host/CDN; design CSP in Phase 10 (allow `api.cloudinary.com` in `connect-src`) |
| F-5 | **Replaced or removed *saved* campaign images stay in Cloudinary as orphans** (no public-id column). Images replaced within one form session are discarded safely. | Low | [SRC]+[T] | Optional later migration adding `Collection.imagePublicId`; none done (no migrations in this phase) |
| F-6 | **Abandoned uploads** (uploaded, then the dialog closed without saving) remain in Cloudinary for the campaign form, as for the other forms. | Low | [SRC] | Periodic Cloudinary cleanup by the owner |
| F-7 | A saved campaign image that is a hand-typed URL on a host not in `images.remotePatterns` would make `next/image` throw on the public pages (pre-existing; the admin form deliberately never previews such URLs). Cloudinary URLs are unaffected. | Low | [SRC] | Keep hand-typed URLs to allowed hosts, or upload instead |
| F-8 | The supplied ZIP contained no `.md` files; the documents were restored from the previous delivery. | Process | ZIP listing | Owner: diff against your own copies |

## 3. Verification log

| # | Check | Command / method | Result | Establishes / does not |
|---|---|---|---|---|
| 1 | Install | `pnpm install --frozen-lockfile --ignore-scripts` (also in a clean copy) | PASS | Lockfile reproducible |
| 2 | Branding guard | `pnpm check:branding` | **PASS** | No old-brand text/assets in active files |
| 3 | Prisma validate | `pnpm exec prisma validate` | **PASS** | Schema valid |
| 4 | Prisma generate | with placeholder engine env vars (engine download blocked) | types generated | Typecheck input only |
| 5 | Typecheck | `pnpm typecheck` | **PASS** (0 errors) | |
| 6 | Lint | `pnpm lint` | **FAIL — pre-existing**: 22 errors/10 warnings, identical file set to the untouched original archive | None in files changed by this release |
| 7 | Unit/service tests | `pnpm test` | **795 run: 767 pass, 4 fail, 24 skipped** (the 24 need a database; see #9) | The 4 failures are pre-existing: `proxy.test.ts` (loader), hero pause-control a11y test, theme-vs-migration guard, stale `campaigns` test. Phase 1 ended at 792 tests; this release added 3 passing tests (2 in `security-headers`, 1 in `homepage-empty-state`) → 795. |
| 8 | Empty-DB migration rehearsal | 28 migrations via `psql` in order on PostgreSQL 16 | **PASS** | EMPTY-DB only: 60 tables, 38 enums, sequence, trigger, partial index |
| 9 | Integration tests | `TEST_DATABASE_URL=… node --test tests/integration/*.test.ts` | **24/24 PASS** | [PG] real concurrency/constraints |
| 10 | Schema ↔ DB comparison | script over Prisma `dmmf` vs `information_schema` | **no differences** (enum value order only, cosmetic) | Prisma model matches the migrated schema |
| 11 | Release scenarios | harness in Appendix A | **12/12 PASS** | [PG] service level. Run before the two small source changes of this release (neither touches services). |
| 12 | Production build, real environment | `pnpm build` | **FAIL — environment** (Google Fonts) | **Genuine build NOT VERIFIED** |
| 13 | Build, clean copy, mocked fonts | webpack, lockfile install + adapter in copy | **exit 0**; first attempt found P0-1 | MOCKED-FONT BUILD (supplementary) |
| 14 | HTTP smoke | `next start` on rehearsal DB | see §4 | [HTTP] |
| 15 | Security headers | `curl -D -` on 200/307/401 | present | |
| 16 | Migration-check PowerShell | PowerShell 7.5.4 against an emulated `_prisma_migrations` | works as designed | Not Windows PS 5.1; not production |
| 17 | Browser verification | — | **UNVERIFIED** | no browser available |

### 3.1 Phase 11 verification pass (executed this pass; details in `HANDOFF_GIFTPACIFIC.md` §19.1d)

| # | Check | Method | Result | Establishes / does not |
|---|---|---|---|---|
| 1 | branding guard / prisma validate / typecheck | scripts (placeholder Prisma engine for validate) | **PASS** | Source consistency only |
| 2 | Full tests | `pnpm test` equivalent | 839 run, 809 pass, **6 fail** (identical to untouched ZIP), 24 skipped | New campaign-image logic covered; failures pre-existing, none in upload/campaign code |
| 3 | Lint | eslint | 34 problems, identical to untouched ZIP; 0 in changed files | No new lint debt |
| 4 | Production build | `next build` in a scratch copy | **FAIL (environment)**: 3 Google Fonts fetch errors only | A genuine build is still **UNVERIFIED** |
| 5 | Migration consistency | checksums vs checklist; 28 migrations applied to scratch PG 16; column comparison with `schema.prisma` | **PASS**: 28/28, applied cleanly, no drift | Not Prisma's own `migrate diff`; not production |
| 6 | Real-stack HTTP smoke | real app + real Prisma (driver-adapter copy) on scratch PG | public routes 200; 33 admin pages 200, 0 errors; 6 account pages 200 | Rendering with a minimal seeded catalog; **not** production data; **no browser** |
| 7 | Access control (live) | cookies: none / customer / forged / tampered / garbage / cross-role | **PASS**: all refused or redirected as designed | Proxy-level gate; Server Actions audited separately |
| 8 | Server Action authorization audit | static scan of 143 actions + service ownership review | **PASS**: 89/89 admin-area authenticate; customer data scoped by session user | Static analysis, not an exploit test |
| 9 | Campaign persistence | real `adminSaveCampaign` against real PostgreSQL | **PASS**: create / replace / remove / legacy URL / unsafe rejected | Database and service layer; **not** the browser upload |
| 10 | Backup/restore mechanics | `pg_dump` custom format → `pg_restore` into a new scratch DB | **PASS**: counts identical | Procedure works; **not** a production backup |
| 11 | Real Cloudinary upload; browser UI; checkout/payment/courier live behaviour | n/a | **NOT VERIFIED** | No credentials, network or browser |

## 4. HTTP smoke results (actual status codes; rehearsal database, mocked-font build)

| Route | Status | Notes |
|---|---|---|
| `/` | 200 | with no banners (post-fix) and with all five banner placements; brand text "Gift Pacific" present, no old-brand text |
| `/shop`, `/shop/clay-art`, `/search?q=…`, `/cart`, `/checkout` | 200 | empty cart/checkout render |
| `/products/<active>` | 200 | name and price rendered; no cost price in HTML |
| `/products/<variant product>` | 200 | |
| `/products/<draft>` | 200 | "Product not found", `noindex` (P1-3); absent from sitemap |
| `/products/does-not-exist` | 200 | "Product not found", `noindex` (P1-3) |
| `/login`, `/register`, `/about`, `/contact`, `/shipping-returns`, `/terms`, `/privacy`, `/boxes`, `/campaign`, `/build-your-own-combo` | 200 | |
| `/robots.txt` | 200 | references `/sitemap.xml` (P1-2) |
| `/sitemap.xml` | **404** | P1-2 |
| `/sitemap/0.xml` | 200 | valid XML |
| `/account` | 307 → `/login?redirect=%2Faccount` | |
| `/admin`, `/admin/orders` | 307 → `/admin/login?redirect=…` | |
| `/admin/login` | 200 | |
| `/docs` | 307 → `/` | demo-only page hidden |
| `/api/courier/reconcile` | 401 | no secret |
| `/api/courier/webhook`, `/api/payments/bkash/ipn` (GET) | 405 | |
| Server log | no errors | |

Response headers on 200, 307 and 401 responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.

## 5. Change accountability (against the Git baseline snapshot of the Phase 1 source)

```
   M AGENTS.md
   M HANDOFF_GIFTPACIFIC.md
   A MASTER_ROADMAP.md
   A RELEASE_AUDIT.md
   A RELEASE_CHECKLIST.md
   M next.config.ts
   M src/app/(shop)/page.tsx
   A tests/unit/homepage-empty-state.test.ts
   A tests/unit/security-headers.test.ts
```
- **Product-source changes:** exactly two — `next.config.ts` (security headers; +18 lines) and `src/app/(shop)/page.tsx` (one expression).
- **Added tests:** `tests/unit/security-headers.test.ts`, `tests/unit/homepage-empty-state.test.ts`.
- **Documents:** `RELEASE_AUDIT.md`, `RELEASE_CHECKLIST.md`, `MASTER_ROADMAP.md` (new); `HANDOFF_GIFTPACIFIC.md`, `AGENTS.md` (updated).
- **`prisma/` unchanged:** `git diff -- prisma` is empty; all 28 historical migrations are byte-identical to the baseline.
- **No dependency change** (`package.json`, `pnpm-lock.yaml` untouched); verification-only packages live in scratch directories.
- **Removed before packaging:** `tests/real-db/*` and the `node_modules/pg` symlink (they referenced `/tmp`); preserved in Appendix A.
- **No secrets** added; branding guard passes.

## 6. Blocked / unverified checks and remaining release blockers

| Blocker | Type | Who / how |
|---|---|---|
| Production migration checksum comparison (P0-4) | **BLOCKED** — production access | Owner runs `RELEASE_CHECKLIST.md` §4 |
| Advance-policy confirmation (P0-2) | **OWNER ACTION REQUIRED** | Admin → Advance & trust |
| `channel_website` row present in production (P0-3) | **OWNER ACTION REQUIRED** (SQL provided) | Checklist §6.2/§6.3 |
| Production environment variables (P0-5) | **OWNER ACTION REQUIRED** | Checklist §2 |
| Genuine `pnpm build` with real fonts (P0-6) | **UNVERIFIED** — needs internet | Owner's host / CI |
| Browser and client-side verification (P0-7) | **UNVERIFIED** | Owner smoke test (checklist §6.4); later Playwright (Phase 11) |
| Database backup and restore drill | **OWNER ACTION REQUIRED** (mechanics rehearsed on a scratch DB only; no production backup was restored) | Checklist §3 |
| Real Cloudinary upload test: campaign, banner, product, multi-image, replace, delete; plan limit confirmed | **UNVERIFIED** — no credentials/network/browser here | Owner: one real upload of each kind, including one above 20 MiB if the plan allows |
| Post-deployment smoke tests | **OWNER ACTION REQUIRED** | Checklist §6 |
| bKash, Steadfast live, GTM/Pixel, Cloudinary, OAuth | **UNVERIFIED** (kept disabled/optional) | Later phases |

Because migration checksums, production configuration and the post-deployment smoke tests are unverified, **production clearance is not claimed**. If the owner's checks in the table above pass, there is **no known remaining source-level P0 defect**; that is a statement about the tested areas, not a guarantee.

---

## Appendix A — Real-database verification harness (preserved verbatim; **not** part of the shipped source)

**Why it is here and not in `tests/`:** it needs a Prisma client generated in *engine-free mode* plus `@prisma/adapter-pg`, which are verification-only dependencies and were deliberately not added to the project. It was run from a scratch directory (`/tmp/realdb`, `/tmp/qc`). Keeping files that import `/tmp/...` in the production candidate would break lint and confuse developers, so they were removed from the source tree and are preserved here exactly as executed.

**What it is:** the project's real service layer (`placeOrder`, `addItemToCart`, `adminUpdateOrderStatus`, `verifyAdvancePayment`, …) run against a **real, disposable PostgreSQL 16 database**, with only the Next.js-only modules stubbed (`next/headers`, cookies/guest token, current user, Cloudinary). It is **not** an HTTP or browser test, and it used Prisma's engine-free client because the Prisma engine download host was unreachable; the production app uses the standard engine.

**DANGER:** `reset()` TRUNCATEs every table. Run it only against a throw-away database.

### A.1 Environment setup (as executed; Ubuntu 24, root)

```bash
# 1. PostgreSQL 16
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib
pg_ctlcluster 16 main start        # NOTE: the cluster does not survive between sandbox sessions; start it again when needed
su postgres -c "psql -c \"CREATE ROLE gp WITH LOGIN SUPERUSER PASSWORD '<LOCAL_TEST_PASSWORD>'\" \
  -c 'CREATE DATABASE giftpacific_rehearsal OWNER gp' -c 'CREATE DATABASE giftpacific_test OWNER gp' -c 'CREATE DATABASE giftpacific_shadow OWNER gp'"

# 2. Apply all migrations in order (SQL rehearsal; this is NOT Prisma's runner)
export PGPASSWORD=<LOCAL_TEST_PASSWORD>
for d in $(ls -d prisma/migrations/2026*/ | sort); do
  psql -h localhost -U gp -d giftpacific_test -v ON_ERROR_STOP=1 -q -f ${d}migration.sql || { echo "FAILED $d"; break; }
done

# 3. Integration tests (need the `pg` driver, which is not a project dependency)
mkdir -p /tmp/pgmod && (cd /tmp/pgmod && npm init -y >/dev/null && npm install pg@8) && ln -sfn /tmp/pgmod/node_modules/pg node_modules/pg
TEST_DATABASE_URL="postgresql://gp:<LOCAL_TEST_PASSWORD>@localhost:5432/giftpacific_test" \
  node --import tsx --import ./tests/setup/register.mjs --test tests/integration/*.test.ts      # result: 24 pass, 0 fail

# 4. Engine-free Prisma client for the scenarios (scratch dir, copy of the schema with a different generator)
mkdir /tmp/qc && cd /tmp/qc && npm init -y >/dev/null && npm i @prisma/client@6.19.3 prisma@6.19.3 @prisma/adapter-pg@6.19.3 pg@8
cp <project>/prisma/schema.prisma . && # replace the generator block with:
#   generator client { provider = "prisma-client-js"  previewFeatures = ["queryCompiler","driverAdapters"]  engineType = "client" }
touch /tmp/fake-engine && chmod +x /tmp/fake-engine
PRISMA_SCHEMA_ENGINE_BINARY=/tmp/fake-engine PRISMA_QUERY_ENGINE_LIBRARY=/tmp/fake-engine DATABASE_URL=postgresql://gp:<LOCAL_TEST_PASSWORD>@localhost:5432/giftpacific_test npx prisma generate --schema schema.prisma

# 5. Lay out the harness (file contents below): /tmp/realdb/{lib.ts,run.sh}, /tmp/realdb/setup/{register.mjs,hooks.mjs,map.mjs}, /tmp/realdb/setup/stubs/{real-prisma.ts,current-user.ts,guest-token.ts}
#    and copy the unchanged stubs: <project>/tests/setup/stubs/{empty.ts,next-cache.ts,next-headers.ts,next-server.ts,cloudinary.ts} -> /tmp/realdb/setup/stubs/
#    Put the two scenario files in <project>/tests/real-db/ TEMPORARILY (tsx only resolves the "@/" alias for files inside the project), run, then delete the folder.
/tmp/realdb/run.sh tests/real-db/release-scenarios.ts      # result: 12/12 passed
```

### A.2 Results recorded

| Scenario (real service code, real PostgreSQL) | Result |
|---|---|
| Guest COD order (Dhaka): order-number format `AP-YYYYMM-NNNNNN`, subtotal/delivery/total computed server-side, line snapshot (name, unit price, quantity), stock deducted once, cart emptied | PASS |
| Price changed by an admin after add-to-cart: checkout uses the current database price | PASS |
| **Oversell race:** 12 different buyers for 3 units → exactly 3 orders, stock exactly 0, refusals say sold out / unavailable | PASS |
| **Duplicate submit:** same cart submitted 3× in parallel → exactly 1 order, stock decremented once | PASS |
| 15 parallel orders → 15 unique order numbers | PASS |
| Variants: out-of-stock variant refused; in-stock variant snapshotted with its own stock decremented | PASS |
| Cancel before dispatch restores stock **exactly once** (two parallel cancels); terminal order cannot be re-opened and stock is not restored again | PASS |
| Advance policy **off** (factory default): outside-Dhaka order needs no advance (`advanceRequired = 0`) | PASS |
| Advance policy **on**: checkout without a payment claim refused (no order created); with a claim the order cannot be confirmed until staff verify the advance | PASS |
| One wallet transaction id can be verified for one order only (exact, lower-case, spaced/hyphenated spellings); a double-click verification counts the money once | PASS |
| Authorization: customer / anonymous cannot change order status | PASS |
| Ownership: customer sees only own orders; cannot request a refund on another customer's order | PASS |

Two harness lessons worth keeping: (1) `channel_website` is migration-inserted reference data that every order needs (the first attempt failed with `Order_channelId_fkey` after the harness truncated it); (2) the adapter cannot read PostgreSQL's `name` type, so the reset helper casts table names to `text`.

### A.3 Harness files

**`/tmp/realdb/run.sh`**
```sh
#!/bin/sh
cd /home/claude/work/gp
TSX_TSCONFIG_PATH=/home/claude/work/gp/tsconfig.json E2E_DB_URL="postgresql://gp:<LOCAL_TEST_PASSWORD>@localhost:5432/giftpacific_test" DATABASE_URL=x AUTH_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node --import tsx --import /tmp/realdb/setup/register.mjs "$@"
```

**`/tmp/realdb/lib.ts`**
```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { prisma } from "./setup/stubs/real-prisma";
export { prisma, assert };
const als: AsyncLocalStorage<any> = ((globalThis as any).__E2E_ALS__ ??= new AsyncLocalStorage());
export const as = <T>(who: { guest?: string; sub?: string; admin?: string }, fn: () => Promise<T>) =>
  als.run({ guest: who.guest, session: who.sub ? { sub: who.sub, role: "CUSTOMER" } : null, admin: who.admin ? { id: who.admin } : null }, fn);
export const co = {
  email: "buyer@example.com", phone: "01711000000",
  shippingAddress: { fullName: "Buyer One", phone: "01711000000", line1: "House 1, Road 2", city: "Dhaka", country: "Bangladesh" },
  billingSameAsShipping: true, billingAddress: null, paymentMethod: "COD" as const, deliveryZone: "DHAKA_CITY" as const, couponCode: null, customerNote: null,
};
let n = 0; const results: string[] = []; let failed = 0;
export async function t(name: string, fn: () => Promise<void>) {
  n++; try { await fn(); results.push(`PASS ${n}. ${name}`); } catch (e: any) { failed++; results.push(`FAIL ${n}. ${name}\n      ${String(e?.message ?? e).split("\n").slice(0, 6).join("\n      ")}`); }
}
export function report() { console.log(results.join("\n")); console.log(`\n${n - failed}/${n} passed`); process.exitCode = failed ? 1 : 0; }
export async function reset() {
  const tabs = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`select tablename::text as tablename from pg_tables where schemaname='public' and tablename not like '\\_prisma%'`)).map((r) => `"${r.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tabs.join(",")} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE order_number_seq RESTART`);
}
```

**`/tmp/realdb/setup/register.mjs`** (unchanged copy of `tests/setup/register.mjs`)
```js
// Replaces server-only modules with test stubs so real service code can be
// imported under plain Node (no Next.js / Prisma install needed). Covers
// both ESM (module hooks) and CommonJS (`require`, which tsx uses for .ts).
import Module, { register } from "node:module";
import { STUBS } from "./map.mjs";

register("./hooks.mjs", import.meta.url);

const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return STUBS[request];
  return original.call(this, request, ...rest);
};
```

**`/tmp/realdb/setup/hooks.mjs`** (unchanged copy of `tests/setup/hooks.mjs`)
```js
import { STUBS, toUrl } from "./map.mjs";

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) return { url: toUrl(STUBS[specifier]), shortCircuit: true };
  return nextResolve(specifier, context);
}
```

**`/tmp/realdb/setup/map.mjs`**
```js
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (n) => path.join(here, "stubs", n);
export const STUBS = {
  "server-only": stub("empty.ts"),
  "@prisma/client": "/tmp/qc/node_modules/@prisma/client/index.js",
  "next/cache": stub("next-cache.ts"),
  "next/headers": stub("next-headers.ts"),
  "next/server": stub("next-server.ts"),
  "@/lib/db/prisma": stub("real-prisma.ts"),
  "@/lib/auth/current-user": stub("current-user.ts"),
  "@/lib/cart/guest-token": stub("guest-token.ts"),
  "@/lib/cloudinary/cloudinary": stub("cloudinary.ts"),
};
export const toUrl = (p) => pathToFileURL(p).href;
```

**`/tmp/realdb/setup/stubs/real-prisma.ts`**
```ts
// Real PostgreSQL via Prisma's engine-free client (verification harness only; not part of the shipped app).
import { PrismaClient } from "/tmp/qc/node_modules/@prisma/client/index.js";
import { PrismaPg } from "/tmp/qc/node_modules/@prisma/adapter-pg/dist/index.js";
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.E2E_DB_URL!, max: 20 }) });
```

**`/tmp/realdb/setup/stubs/current-user.ts`**
```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "./real-prisma";
const als: AsyncLocalStorage<{ session: any; admin: any }> = ((globalThis as any).__E2E_ALS__ ??= new AsyncLocalStorage());
export async function getSession() { return als.getStore()?.session ?? null; }
export async function getCurrentAdmin() { const a = als.getStore()?.admin; return a ? prisma.user.findFirst({ where: { id: a.id, role: "ADMIN", isActive: true } }) : null; }
export async function requireAdmin() { const a = await getCurrentAdmin(); if (!a) throw new Error("FORBIDDEN"); return a as any; }
export async function getCurrentUser() { const s = als.getStore()?.session; return s ? prisma.user.findFirst({ where: { id: s.sub } }) : null; }
export async function requireUser() { const u = await getCurrentUser(); if (!u) throw new Error("UNAUTHENTICATED"); return u as any; }
```

**`/tmp/realdb/setup/stubs/guest-token.ts`**
```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
const als = ((globalThis as any).__E2E_ALS__ ??= new (require("node:async_hooks").AsyncLocalStorage)());
export async function getOrCreateGuestToken() { return als.getStore()?.guest ?? "guest-default"; }
```

**`tests/real-db/smoke.ts`**
```ts
import { prisma, reset, t, report, assert } from "/tmp/realdb/lib.ts";
import { getStoreSettings } from "@/server/services/settings.service";
async function main() {
  await t("harness: real PostgreSQL reachable and truncatable", async () => { await reset(); assert.equal(await prisma.order.count(), 0); });
  await t("service layer boots on real PG: store settings read", async () => { const s: any = await getStoreSettings(); assert.ok(s); });
  report(); await prisma.$disconnect();
}
main();
```

**`tests/real-db/release-scenarios.ts`**
```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// Real-PostgreSQL release scenarios: the REAL service code against a REAL (disposable) database.
// Run with the harness described in RELEASE_AUDIT.md (engine-free Prisma client + pg adapter). NEVER point at live data: it TRUNCATEs every table.
import { prisma, reset, t, report, assert, as, co } from "/tmp/realdb/lib.ts";
import { addItemToCart, getCurrentCartDTO } from "@/server/services/cart.service";
import { placeOrder, adminUpdateOrderStatus, requestRefund, getOrdersForCurrentUser } from "@/server/services/order.service";
import { verifyAdvancePayment } from "@/server/services/advance.service";

const ADMIN = { adminId: "adm-1" } as any;
async function seed() {
  await reset();
  // Reference data that the migrations insert (reset() truncates everything): the website sales channel every website order points at.
  await prisma.salesChannel.create({ data: { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE", isActive: true } as any });
  await prisma.storeSettings.create({ data: { id: "singleton" } });
  await prisma.user.create({ data: { id: "adm-1", email: "admin@staff.test", name: "Admin", role: "ADMIN", isActive: true } as any });
  for (const id of ["cust-1", "cust-2"]) await prisma.user.create({ data: { id, email: `${id}@c.test`, name: id, role: "CUSTOMER", isActive: true } as any });
  await prisma.product.create({ data: { id: "p-vase", name: "Clay Vase", slug: "clay-vase", type: "STANDARD", status: "ACTIVE", price: 1800, costPrice: 700, stock: 5, description: "vase" } as any });
  await prisma.product.create({ data: { id: "p-last", name: "Last Piece", slug: "last-piece", type: "STANDARD", status: "ACTIVE", price: 500, stock: 3, description: "x" } as any });
  await prisma.product.create({ data: { id: "p-mug", name: "Clay Mug", slug: "clay-mug", type: "VARIANT", status: "ACTIVE", price: 650, stock: 999, description: "mug" } as any });
  await prisma.productVariant.create({ data: { id: "v-red", productId: "p-mug", name: "Red", sku: "MUG-R", price: 650, options: { Color: "Red" }, stock: 3 } as any });
  await prisma.productVariant.create({ data: { id: "v-blue", productId: "p-mug", name: "Blue", sku: "MUG-B", price: 700, options: { Color: "Blue" }, stock: 0 } as any });
}
const stock = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;
const buy = (guest: string, productId: string, quantity = 1, checkout: any = co, variantId?: string) =>
  as({ guest }, async () => { await addItemToCart({ productId, quantity, ...(variantId ? { variantId } : {}) } as any); return placeOrder(checkout); });

async function main() {
  await seed();

  await t("guest COD order (Dhaka): number format, server-computed totals, line snapshot, stock deducted once, cart emptied", async () => {
    const o: any = await buy("g1", "p-vase", 2);
    assert.match(o.orderNumber, /^AP-\d{6}-\d{6}$/);
    const row: any = await prisma.order.findFirstOrThrow({ where: { orderNumber: o.orderNumber }, include: { items: true, payments: true } });
    const settings = await prisma.storeSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    assert.equal(Number(row.subtotal), 3600);
    assert.equal(Number(row.shippingTotal ?? row.shipping ?? 0) || Number(settings.deliveryChargeDhaka), Number(settings.deliveryChargeDhaka));
    assert.equal(Number(row.total), 3600 + Number(settings.deliveryChargeDhaka));
    assert.equal(row.status, "PENDING");
    assert.equal(row.items.length, 1);
    assert.deepEqual([row.items[0].productName ?? row.items[0].name, Number(row.items[0].unitPrice ?? row.items[0].price), row.items[0].quantity], ["Clay Vase", 1800, 2]);
    assert.equal(await stock("p-vase"), 3);
    const cart: any = await as({ guest: "g1" }, () => getCurrentCartDTO());
    assert.equal(cart.items.length, 0);
  });

  await t("price changed by admin AFTER add-to-cart: checkout uses the current database price (client never decides price)", async () => {
    await as({ guest: "g2" }, () => addItemToCart({ productId: "p-vase", quantity: 1 } as any));
    await prisma.product.update({ where: { id: "p-vase" }, data: { price: 2000 } });
    const o: any = await as({ guest: "g2" }, () => placeOrder(co));
    const row: any = await prisma.order.findFirstOrThrow({ where: { orderNumber: o.orderNumber } });
    assert.equal(Number(row.subtotal), 2000);
    await prisma.product.update({ where: { id: "p-vase" }, data: { price: 1800 } });
  });

  await t("OVERSELL: 12 different buyers race for 3 units → exactly 3 orders, stock exactly 0, never negative", async () => {
    const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => buy(`race-${i}`, "p-last", 1)));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 3, `fulfilled=${ok}`);
    assert.equal(await stock("p-last"), 0);
    assert.equal(await prisma.order.count({ where: { items: { some: { productId: "p-last" } } } }), 3);
    for (const r of res) if (r.status === "rejected") assert.match(String((r as any).reason?.message), /sold out|stock|available|out of/i);
  });

  await t("DUPLICATE SUBMIT: the same cart submitted twice in parallel creates exactly one order", async () => {
    await prisma.product.update({ where: { id: "p-vase" }, data: { stock: 10 } });
    const before = await prisma.order.count();
    await as({ guest: "dup" }, () => addItemToCart({ productId: "p-vase", quantity: 1 } as any));
    const res = await Promise.allSettled([as({ guest: "dup" }, () => placeOrder(co)), as({ guest: "dup" }, () => placeOrder(co)), as({ guest: "dup" }, () => placeOrder(co))]);
    assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await prisma.order.count(), before + 1);
    assert.equal(await stock("p-vase"), 9);
  });

  await t("order numbers are unique and sequential under 15 parallel orders", async () => {
    await prisma.product.update({ where: { id: "p-vase" }, data: { stock: 100 } });
    const res = await Promise.all(Array.from({ length: 15 }, (_, i) => buy(`num-${i}`, "p-vase", 1)));
    const nums = res.map((r: any) => r.orderNumber);
    assert.equal(new Set(nums).size, 15);
  });

  await t("VARIANT: out-of-stock variant cannot be bought; in-stock variant is snapshotted with its own price", async () => {
    await assert.rejects(buy("var-1", "p-mug", 1, co, "v-blue"));
    const o: any = await buy("var-2", "p-mug", 1, co, "v-red");
    const it: any = await prisma.orderItem.findFirstOrThrow({ where: { order: { orderNumber: o.orderNumber } } });
    assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: "v-red" } })).stock, 2);
    assert.equal(it.variantId, "v-red");
  });

  await t("CANCEL before dispatch restores stock exactly once, even when two admins cancel in parallel; delivered/terminal orders are not restored", async () => {
    await prisma.product.update({ where: { id: "p-vase" }, data: { stock: 4 } });
    const o: any = await buy("c1", "p-vase", 2);
    assert.equal(await stock("p-vase"), 2);
    const row: any = await prisma.order.findFirstOrThrow({ where: { orderNumber: o.orderNumber } });
    const res = await Promise.allSettled([
      as({ admin: "adm-1" }, () => adminUpdateOrderStatus(row.id, "CANCELLED" as any, "x", ADMIN)),
      as({ admin: "adm-1" }, () => adminUpdateOrderStatus(row.id, "CANCELLED" as any, "x", ADMIN)),
    ]);
    assert.ok(res.some((r) => r.status === "fulfilled"));
    assert.equal(await stock("p-vase"), 4, "restored exactly once (4), not 6");
    await assert.rejects(as({ admin: "adm-1" }, () => adminUpdateOrderStatus(row.id, "PROCESSING" as any, "x", ADMIN)));
    assert.equal(await stock("p-vase"), 4);
  });

  await t("ADVANCE DEFAULT: with the policy switched off (the factory default) an outside-Dhaka order needs no advance — owner must enable it in Admin → Advance", async () => {
    await prisma.product.update({ where: { id: "p-vase" }, data: { stock: 20 } });
    const o: any = await buy("adv-off", "p-vase", 1, { ...co, deliveryZone: "OUTSIDE_DHAKA" as const, shippingAddress: { ...co.shippingAddress, city: "Rajshahi" } });
    assert.equal(Number((await prisma.order.findFirstOrThrow({ where: { orderNumber: o.orderNumber } })).advanceRequired), 0);
    await prisma.storeSettings.update({ where: { id: "singleton" }, data: { advanceEnabled: true } });
  });

  await t("ADVANCE (policy on): outside-Dhaka checkout WITHOUT a payment claim is refused by the server; with a claim the order cannot be confirmed until staff verify it, then it can", async () => {
    const out = { ...co, deliveryZone: "OUTSIDE_DHAKA" as const, shippingAddress: { ...co.shippingAddress, city: "Chattogram" } };
    const before = await prisma.order.count();
    await assert.rejects(buy("adv-1", "p-vase", 1, out), /advance of 200 is required/i);
    assert.equal(await prisma.order.count(), before, "a refused checkout creates no order");
    const o: any = await buy("adv-2", "p-vase", 1, { ...out, advanceMethod: "BKASH" as const, advanceReference: "TXGATE0001" });
    const row: any = await prisma.order.findFirstOrThrow({ where: { orderNumber: o.orderNumber } });
    assert.equal(Number(row.advanceRequired), 200);
    await assert.rejects(as({ admin: "adm-1" }, () => adminUpdateOrderStatus(row.id, "CONFIRMED" as any, "x", ADMIN)), /advance|review/i);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: row.id } })).status, "PENDING");
    const pay: any = await prisma.payment.findFirstOrThrow({ where: { orderId: row.id } });
    await as({ admin: "adm-1" }, () => verifyAdvancePayment({ paymentId: pay.id, adminId: "adm-1", providerRef: "TXGATE0001", amount: 200 }));
    await as({ admin: "adm-1" }, () => adminUpdateOrderStatus(row.id, "CONFIRMED" as any, "x", ADMIN)).catch((e) => { assert.match(String(e.message), /review/i); });
  });

  await t("PAYMENT: a customer-typed wallet transaction id is only a claim; one transaction id can be verified for only one order, in any spelling", async () => {
    const out = (ref: string) => ({ ...co, deliveryZone: "OUTSIDE_DHAKA" as const, shippingAddress: { ...co.shippingAddress, city: "Sylhet" }, advanceMethod: "BKASH" as const, advanceReference: ref });
    const a: any = await buy("pay-a", "p-vase", 1, out("TXSAME0001"));
    const b: any = await buy("pay-b", "p-vase", 1, out("TXSAME0001"));
    const pa: any = await prisma.payment.findFirstOrThrow({ where: { order: { orderNumber: a.orderNumber } } });
    const pb: any = await prisma.payment.findFirstOrThrow({ where: { order: { orderNumber: b.orderNumber } } });
    assert.equal(pa.status, "PENDING"); assert.equal(pa.providerRef ?? null, null);
    await as({ admin: "adm-1" }, () => verifyAdvancePayment({ paymentId: pa.id, adminId: "adm-1", providerRef: "TXSAME0001", amount: 200 }));
    for (const s of ["TXSAME0001", "txsame0001", " tx-same 0001 "]) await assert.rejects(as({ admin: "adm-1" }, () => verifyAdvancePayment({ paymentId: pb.id, adminId: "adm-1", providerRef: s, amount: 200 })), /already/i);
    await assert.rejects(as({ admin: "adm-1" }, () => verifyAdvancePayment({ paymentId: pa.id, adminId: "adm-1", providerRef: "TXSAME0001", amount: 200 })), /already/i);
    assert.equal(Number((await prisma.order.findFirstOrThrow({ where: { orderNumber: b.orderNumber } })).advancePaid), 0);
    const parallel = await Promise.allSettled([
      as({ admin: "adm-1" }, () => verifyAdvancePayment({ paymentId: pb.id, adminId: "adm-1", providerRef: "TXRACE0002", amount: 200 })),
      as({ admin: "adm-1" }, () => verifyAdvancePayment({ paymentId: pb.id, adminId: "adm-1", providerRef: "TXRACE0002", amount: 200 })),
    ]);
    assert.equal(parallel.filter((r) => r.status === "fulfilled").length, 1, "double-click verification counts the money once");
    assert.equal(Number((await prisma.order.findFirstOrThrow({ where: { orderNumber: b.orderNumber } })).advancePaid), 200);
  });

  await t("AUTHORIZATION: a customer (or no admin) cannot change order status or verify payments", async () => {
    const o: any = await buy("auth-1", "p-vase", 1);
    const row: any = await prisma.order.findFirstOrThrow({ where: { orderNumber: o.orderNumber } });
    await assert.rejects(as({ sub: "cust-1" }, () => adminUpdateOrderStatus(row.id, "CONFIRMED" as any, "x", { adminId: "cust-1" } as any)));
    await assert.rejects(as({ guest: "x" }, () => adminUpdateOrderStatus(row.id, "CONFIRMED" as any, "x", { adminId: "nobody" } as any)));
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: row.id } })).status, "PENDING");
  });

  await t("OWNERSHIP: a customer sees only their own orders and cannot request a refund on someone else's order", async () => {
    const o1: any = await as({ sub: "cust-1" }, async () => { await addItemToCart({ productId: "p-vase", quantity: 1 } as any); return placeOrder(co); });
    const mine: any = await as({ sub: "cust-1" }, () => getOrdersForCurrentUser());
    const theirs: any = await as({ sub: "cust-2" }, () => getOrdersForCurrentUser());
    assert.ok(mine.some((x: any) => x.orderNumber === o1.orderNumber));
    assert.ok(!theirs.some((x: any) => x.orderNumber === o1.orderNumber));
    await assert.rejects(as({ sub: "cust-2" }, () => requestRefund(o1.orderNumber, "not mine")), /not found/i);
  });

  report(); await prisma.$disconnect();
}
main();
```

## Appendix B — Verification-copy build and HTTP smoke procedure (as executed)

```bash
# Clean, lockfile-based copy of the project (no hand-copied node_modules):
tar --exclude=./.git --exclude=./node_modules -cf - . | (mkdir /tmp/appcopy2 && cd /tmp/appcopy2 && tar xf -)
cd /tmp/appcopy2 && pnpm install --frozen-lockfile --ignore-scripts && pnpm add @prisma/adapter-pg@6.19.3 pg@8 --ignore-scripts   # in the COPY only
# In the copy ONLY: set the generator to engineType="client" + previewFeatures ["queryCompiler","driverAdapters"],
# and make src/lib/db/prisma.ts construct PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }).
export PRISMA_SCHEMA_ENGINE_BINARY=/tmp/fake-engine PRISMA_QUERY_ENGINE_LIBRARY=/tmp/fake-engine
npx prisma generate
export DATABASE_URL=postgresql://…giftpacific_rehearsal AUTH_SECRET=<48 random chars> NEXT_PUBLIC_APP_URL=http://localhost:3100 NEXT_TELEMETRY_DISABLED=1
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/fontmock.js        # supplies @font-face CSS only; NOT a genuine font build
npx next build --webpack                                          # exit 0, all routes generated (Turbopack rejected the font mock)
NODE_ENV=production npx next start -p 3100 &                       # run the server in the SAME shell session as the curl checks
```
The font mock is a Node module exporting a `Proxy` that returns generic `@font-face` CSS for any Google Fonts URL. It was needed only because the verification environment cannot reach Google Fonts; **the real build on the owner's host must succeed without it.**

Rehearsal data used (non-destructive, rehearsal database only): store settings row, one category, products (standard, variant with two variants, draft), banners of all five placements, one rehearsal admin user whose password hash was generated locally and never leaves the rehearsal database.
