# MASTER ROADMAP — Gift Pacific (authoritative long-term plan)

This is the **authoritative Phase 0–11 development plan**. No phase may be deleted, renamed, merged or silently replaced. The **emergency production release is a parallel fast-track**, not a replacement: it fixes only what must be fixed to resume trading safely and records everything else here, mapped to its original phase.

**Rules**
- A phase is **never** marked Completed without evidence. Evidence tiers used below: **[T]** automated tests on an in-memory fake database · **[PG]** executed on a real PostgreSQL 16 database (disposable) · **[HTTP]** executed against the running application (HTTP level, no browser) · **[SRC]** read in the source only · **[—]** nothing executed.
- Statuses: **Completed · Partial · Missing · Broken · Unverified**. "Unverified" means code exists but was never run in a real environment.
- Production-only checks (production database, real providers, real browser, real host) are always **Unverified/BLOCKED** until the owner performs them; see `RELEASE_CHECKLIST.md`.
- Last updated: Phase 1 completion pass on top of the emergency release candidate (supersedes the Phase 1 recommendation list). Evidence detail: `RELEASE_AUDIT.md`. Project detail: `HANDOFF_GIFTPACIFIC.md`.

## Overview

| Phase | Name | Overall status |
|---|---|---|
| 0 | Full Source Audit & Requirement Mapping | **Partial** |
| 1 | Complete Rebranding | **Partial** (code done; assets and production data pending) |
| 2 | Product Domain & Catalog Architecture | **Partial** (current model works; redesign **not started**) |
| 3 | Combo, Mini-combo, Set-combo & Box Engine | **Partial** (redesign **not started**) |
| 4 | Inventory & Procurement | **Partial** (strong core; gaps listed) |
| 5 | Admin Panel Redesign | **Partial** (functional admin; redesign **not started**) |
| 6 | Customer Experience Redesign | **Partial** (functional storefront; redesign **not started**) |
| 7 | Order, Payment & Accounting Integrity | **Partial** (COD/advance verified; online payments unverified) |
| 8 | Courier & Fraud System | **Partial / Unverified** |
| 9 | Marketing & Growth | **Partial / Unverified** |
| 10 | Performance, Security & Reliability | **Partial** |
| 11 | Complete QA & Production Release | **Partial** (emergency fast-track only) |

**Recommended next phase after business restart:** Phase 11's *environment verification* items first (genuine build, production migration rehearsal, browser/E2E smoke) because every later phase adds migrations and UI on top of unverified ground; then **Phase 2**. Do not start Phase 2 before the restart is complete and stable.

---

## Phase 0: Full Source Audit & Requirement Mapping
*Original scope:* Audit source code, database schema, migrations, UI, APIs, tests, and previous requirements. Classify each requirement as Completed, Partial, Missing, Broken, or Unverified.

| Status | Items |
|---|---|
| **Completed** | Source/doc reconciliation done twice (Phase 1 handoff §23 matrix; emergency audit). Schema ↔ migrated database comparison: 60 tables/38 enums, no differences in tables, columns, nullability, base types [PG]. Static authorization audit of all server actions [SRC]. Route inventory (71 pages, 7 API routes) [SRC] and live route smoke [HTTP]. |
| **Partial** | Requirement mapping is by feature area, not a numbered per-requirement trace (the original requirement documents are not in the repository). UI audit covered HTTP/HTML only. |
| **Missing** | A numbered requirement register with ownership and acceptance criteria. |
| **Broken** | — |
| **Unverified** | Browser-rendered UI audit; accessibility audit beyond the automated checks. |
| **Dependencies** | None. |
| **Next** | Create the numbered register from `HANDOFF_GIFTPACIFIC.md` §23 and this file; re-audit after each phase. |

## Phase 1: Complete Rebranding
*Original scope:* Complete the Aura & Petals to Gift Pacific transition across branding, metadata, assets, naming, identifiers, and documentation. <!-- branding-guard:allow (original roadmap wording, preserved verbatim) -->

| Status | Items |
|---|---|
| **Completed** | Text, code, tests, config, docs and storage/cookie identifiers rebranded; legacy compatibility (consent key, confirmation cookie, purchase-tracking and popup keys) [T]; branding guard with fingerprints of the two retired image assets, name/metadata checks, tests [T]; live homepage shows the new brand and no old-brand text [HTTP]. **Phase 1 completion pass:** fallbacks for missing logo/favicon verified on every surface (navbar, mobile nav, admin, invoice, structured data, root/page metadata) [SRC]; loading-screen broken-image reference fixed and guarded [T]; minimal web manifest added (name only, no icons) [T]+[HTTP dev server]; repository migration checksums re-verified (28/28 match the checklist) [SRC]; branding guard, `prisma validate`, typecheck re-run (pass); tests 771 pass / same 4 pre-existing failures. |
| **Partial** | Order-number prefix `AP-` retained by owner decision (**decision still pending; not changed**). Web manifest: exists but is name-only (no icons, not installable). Social sharing: metadata code is correct, but no default share image exists (`StoreSettings.ogImageUrl` empty by design). |
| **Missing** | **Official Gift Pacific logo and favicon assets** (none exist; text fallback in use; upload in Admin → Settings) — OWNER ACTION REQUIRED. **Official default social-share image** (set its link in Admin → Settings → Site & SEO) — OWNER ACTION REQUIRED. **Official PWA icons** (needed before the manifest can make the site installable) — OWNER ACTION REQUIRED. |
| **Broken** | **FIXED in the Phase 1 completion pass:** `src/app/loading.tsx` referenced the deleted `/images/logo.png`, rendering a broken image on the loading screen whenever no logo was set. |
| **Unverified** | Production `StoreSettings.storeName`; **migration checksum drift on migrations 1 and 22 (BLOCKED — owner SQL/PowerShell in `RELEASE_CHECKLIST.md` §4)**; legacy Cloudinary folder names (owner SQL in handoff §22, extended to all six models with public ids; **note: server-side save/delete flows have no folder guard, handoff §22 corrected**); genuine `pnpm build` (Google Fonts); visual brand review in a browser. |
| **Dependencies** | Owner-supplied brand assets. |
| **Next** | Obtain official logo, favicon, share image and PWA icons; decide the `AP-` prefix (handoff §1.1 has the safe path); run the production checks (`RELEASE_CHECKLIST.md` §4 and §6.2). **Phase 1 stays Partial until these are done.** |

## Phase 2: Product Domain & Catalog Architecture
*Original scope:* Product classification, attributes, specifications, variant engine, SKU, pricing, and inventory relationships.

| Status | Items |
|---|---|
| **Completed** (current model) | Product types STANDARD/VARIANT/PERSONALIZED/BUNDLE and kind SINGLE/COMBO; flat variants with SKU, price, stock, image, backorder policy; personalisation fields; product-level attributes with filters; slug redirects; variant stock and pricing at checkout verified on real PostgreSQL ("out-of-stock variant cannot be bought; in-stock variant snapshotted") [PG], product/variant pages render [HTTP]. |
| **Partial** | Variants store options as unstructured JSON (no option axes); attributes are product-level only; "specifications" = attributes + description. |
| **Missing** | Structured option axes and generated variant combinations; a dedicated specification model; variant-level attributes/specifications; type model that lets "personalised + variants" compose; bulk variant tools. **The redesign has NOT been started.** |
| **Broken** | — |
| **Unverified** | Product editor in a browser. |
| **Dependencies** | Phase 11 verification items; owner sign-off on a design document. |
| **Next** | **Highest-priority roadmap phase after the restart** (see handoff §25 for scope). |

## Phase 3: Combo, Mini-combo, Set-combo & Box Engine
*Original scope:* Product composition, immutable set-combo rules, eligible box suggestions, nested combo validation, and stock calculation.

| Status | Items |
|---|---|
| **Completed** (current model) | Fixed and customisable combos with slots; boxes with a hidden managed product; strict component stock; server-side validation and immutable snapshots [T]; combo checkout deadlock-free and stock-correct on real PostgreSQL [PG]; a combo cannot contain another combo (explicit rule in `admin-combo.service.ts`) [SRC]. |
| **Partial** | Stock calculation exists per policy (own stock vs components). "Nested combo validation" is implemented only as a prohibition. |
| **Missing** | Distinct mini-combo and set-combo types; "immutable set-combo rules" as a first-class concept; **eligible box suggestions** (customers can choose boxes in a slot, but nothing suggests eligible boxes); combo-level discount rules beyond fixed/sum pricing. **Redesign NOT started.** |
| **Broken** | — |
| **Unverified** | Combo builder in a browser. |
| **Dependencies** | Phase 2 product engine. |
| **Next** | Design after Phase 2. |

## Phase 4: Inventory & Procurement
*Original scope:* Stock movement, purchase, supplier, stock adjustment, low-stock alert, reservation, and overselling prevention.

| Status | Items |
|---|---|
| **Completed** | Stock movement ledger with idempotency keys; atomic guarded deduction; **overselling prevention proven under concurrency on real PostgreSQL** (12 buyers/3 units → exactly 3 orders, stock 0) [PG]; exactly-once restoration on cancel incl. parallel cancels [PG]; negative stock blocked by DB CHECK [PG]; procurement receipts and backorder policy [T]+[PG]; manual stock adjustment with reason and history [T]. |
| **Partial** | Low-stock: per-product threshold and a dashboard list, **no alerts/notifications**. Reservation: unpaid PENDING orders hold stock (deducted) but **never expire**. Audit: stock adjustments are ledgered; the general admin audit log covers advance/trust/fraud events only. |
| **Missing** | Supplier entity (receipts have only a free-text note), purchase orders, reservation expiry, a "reserved" quantity, low-stock alerts, stock-take/cycle-count tooling. |
| **Broken** | — |
| **Unverified** | Legacy-stock data check against production data (needs a physical count). |
| **Dependencies** | Phase 2 for variant redesign effects. |
| **Next** | Reservation expiry before enabling online payments with pending states (Phase 7). |

## Phase 5: Admin Panel Redesign
*Original scope:* Owner, Inventory, Marketing, and Operations dashboards, role permissions, navigation, reporting, and audit log.

| Status | Items |
|---|---|
| **Completed** (current admin) | 38 admin pages; tabbed product editor; order, advance, accounting, courier, inventory, reviews, careers screens; reports and CSV exports; every admin action guarded and re-checked in the service [SRC]+[PG] (customers/anonymous refused); unauthenticated admin routes redirect to login [HTTP]. |
| **Partial** | Single dashboard (revenue, counts, low stock); reporting exists (sales, channels). Audit log: advance/trust/fraud events. |
| **Missing** | Role-based dashboards (Owner, Inventory, Marketing, Operations); **granular role permissions (only ADMIN/CUSTOMER exist)**; a complete audit log; redesigned navigation. **Redesign NOT started.** |
| **Broken** | — |
| **Unverified** | Admin UI in a browser. |
| **Dependencies** | Role model (needs a migration). |
| **Next** | After Phase 2–4 data-model changes. |

## Phase 6: Customer Experience Redesign
*Original scope:* Home, shop, category, product details, variants, combo builder, cart, checkout, account, order tracking, and responsive UX.

| Status | Items |
|---|---|
| **Completed** (current storefront) | All listed pages exist and **return HTTP 200 with real data** (home, shop, category, product, variant product, search, cart, checkout, login/register, info pages, boxes, campaign, build-your-own-combo) [HTTP]; draft products hidden; internal fields (cost price, hashes) absent from public HTML [HTTP]; order tracking/confirmation/ownership rules [T]+[PG]. |
| **Partial** | Responsive UX never viewed. |
| **Missing** | The redesign itself; a pause control for the auto-rotating hero (accessibility, WCAG 2.2.2). |
| **Broken** | **FIXED in this emergency release:** the homepage returned HTTP 500 whenever no Campaign-placement banner was active (`src/app/(shop)/page.tsx`). Open (P1): unknown/draft product URLs answer HTTP 200 with a "not found" page (`noindex`) instead of 404 (soft 404; caused by the root `loading.tsx` streaming). |
| **Unverified** | Everything that needs a browser: client-side add-to-cart/checkout interaction, drawers, forms, mobile layout. |
| **Dependencies** | Phase 2/3 for variant and combo UI. |
| **Next** | Browser/E2E smoke (Phase 11) before redesign. |

## Phase 7: Order, Payment & Accounting Integrity
*Original scope:* COD, advance, online balance/full payment, payment reconciliation, partial/full refunds, and financial reports.

| Status | Items |
|---|---|
| **Completed** | COD ordering; server-authoritative totals; unique `AP-` order numbers under concurrency; duplicate submission yields one order; advance enforcement and dispatch gate; wallet-claim → staff verification; one transaction id credits one order (any spelling, race-safe) — all **[PG]**. Accounting definitions, COD reconciliation, refund lifecycle [T]. |
| **Partial** | bKash for **advance only** (code present, disabled). Customer refund request flow [T]. |
| **Missing** | **Online balance/full payment** (deliberately not built — four COD places must change together); Nagad; double-entry ledger; courier remittance model. |
| **Broken** | — (4 pre-existing failing tests are outside these paths; see audit). |
| **Unverified** | **bKash entirely** (never run against bKash); migrations 24–28 on production data; accounting numbers vs a real month; refund recovery on real gateway. **OWNER ACTION REQUIRED:** confirm the advance policy in Admin → Advance & trust (default is **off**). |
| **Dependencies** | Phase 4 reservation expiry for online pending payments. |
| **Next** | bKash sandbox verification, then decide online balance/full. |

## Phase 8: Courier & Fraud System
*Original scope:* Steadfast, Pathao, RedX adapters, booking, cancellation, tracking, webhook, fraud lookup, and recovery.

| Status | Items |
|---|---|
| **Completed** | Steadfast adapter, idempotent booking, webhook with constant-time secret, reconcile job, manual courier fallback, fraud-lookup pipeline [T]; courier endpoints refuse unauthenticated calls (401/405) [HTTP]. |
| **Partial** | Recovery (uncertain bookings need an admin check) [T]. |
| **Missing** | **Pathao and RedX adapters** (no official docs/credentials; deliberately not built); courier **cancellation** call; pickup-store selection; OTP phone verification. |
| **Broken** | — |
| **Unverified** | **Steadfast live API** (booking, status mapping, webhook); **fraud endpoint and official response schema**; courier controls stay unavailable with missing credentials (by design). |
| **Dependencies** | Official docs/credentials. |
| **Next** | One authorised Steadfast test parcel; verify the fraud schema. |

## Phase 9: Marketing & Growth
*Original scope:* Campaign, coupon, discounts, Meta Pixel, GTM, analytics, abandoned cart, SEO, and customer retention.

| Status | Items |
|---|---|
| **Completed** | Campaigns, coupons (percentage/fixed), banners (5 placements; rendering verified for each [HTTP]), delivery reward, abandoned-cart list, consent-gated analytics code, SEO metadata/JSON-LD/canonicals/robots, slug redirects [T]; sitemap chunk renders and excludes drafts [HTTP]. |
| **Partial** | Customer retention = delivery reward only. TikTok/LinkedIn snippets unverified. |
| **Missing** | Free-delivery coupon; email/SMS marketing; PWA proper (icons, installability; a minimal name-only manifest was added in Phase 1); default share image (owner asset). |
| **Broken** | `robots.txt` advertises `/sitemap.xml`, which returns **404** (the sitemap is served at `/sitemap/0.xml`) — P1 SEO; workaround: submit `/sitemap/0.xml` in Search Console. |
| **Unverified** | Real GTM/GA4/Meta Pixel/Conversions API accounts. |
| **Dependencies** | Owner accounts/IDs. |
| **Next** | Fix the sitemap index; verify analytics after launch. |

## Phase 10: Performance, Security & Reliability
*Original scope:* Database indexes, query optimization, aggregation, caching, image optimization, concurrency, rate limiting, security, and error handling.

| Status | Items |
|---|---|
| **Completed** | Concurrency control proven on PostgreSQL [PG]; rate limiting [T]; structured error logging; startup configuration checks [T]; **baseline security headers added in this release and verified on real responses (200, 307, 401)** [HTTP]; admin/customer cookie separation; httpOnly/SameSite/secure cookies [SRC]; public-DTO allow-list [T]+[HTTP]. |
| **Partial** | Caching and rate-limit counters are per-instance (in-memory); indexes exist but were never reviewed against real query plans. |
| **Missing** | **Content-Security-Policy** (needs design against GTM, Meta Pixel, Cloudinary, JSON-LD); load testing; query/index audit; hosted error tracking and alerting; `AUTH_SECRET` minimum raised to 32 in code (documented requirement instead). |
| **Broken** | — |
| **Unverified** | Performance under real load; image optimization config in production. |
| **Dependencies** | Production-like data volume. |
| **Next** | CSP design; index audit; error tracker. |

## Phase 11: Complete QA & Production Release
*Original scope:* Regression, integration, E2E, load testing, responsive/browser testing, migration rehearsal, backup/restore, and deployment verification.

| Status | Items |
|---|---|
| **Completed** (fast-track) | Regression: 795 tests (767 pass, 4 pre-existing failures, 24 DB-only) [T]; **24 integration tests passed on real PostgreSQL**; 12 real-database release scenarios [PG]; **migration rehearsal on an empty PostgreSQL 16: all 28 apply** [PG]; read-only production migration-check procedure written **and executed under PowerShell against an emulated table** (not production); HTTP smoke on the built app [HTTP]. |
| **Verified in the latest Phase 11 pass** (see handoff §19.1d) | Real app + real Prisma on an isolated scratch PostgreSQL: public storefront routes, 33 admin pages and 6 customer pages render (HTTP 200, 0 error pages); live access-control and token-tampering checks pass; all 143 Server Actions audited for authorization (89/89 admin-area actions authenticate); schema vs migrations: no drift; dump/restore mechanics rehearsed on scratch [PG]+[HTTP dev]+[SRC]. Campaign image upload added and tested (839 tests; same 6 pre-existing failures). |
| **Partial** | A genuine production build **fails in the sandbox on the three Google Fonts fetches only** (re-attempted, exit 1); earlier builds were verified only with mocked fonts. |
| **Missing** | Browser E2E suite; load testing; responsive/browser matrix; **migration rehearsal on a copy of production data**; **backup/restore drill on a real production backup** (the mechanics were rehearsed on a scratch database only); post-deployment verification on the real host; a **real Cloudinary upload test** (campaign, banner, product). |
| **Broken** | 4 pre-existing failing tests (proxy never runs; hero pause control; theme-vs-migration guard; stale campaigns test) and 22 lint errors — none in order/payment/stock paths. |
| **Unverified** | **Genuine `pnpm build` with Google Fonts**; production deployment; production migration status; browser behaviour (upload UI, cart, forms, checkout flow); real Cloudinary/bKash/courier behaviour. **Phase 11 is NOT complete and production is NOT cleared.** |
| **Dependencies** | Owner access to production and a host with internet. |
| **Next** | Execute `RELEASE_CHECKLIST.md`; then add Playwright E2E and the backup/restore drill. |

---

## Emergency-release deferrals mapped to their original phase

| ID | Deferred item | Priority | Workaround now | Phase |
|---|---|---|---|---|
| D-1 | Gift Pacific logo/favicon assets | P1 | Text store name; upload in Admin → Settings later | 1 |
| D-2 | `/sitemap.xml` 404 (robots points to it) | P1 | Submit `/sitemap/0.xml` | 9 |
| D-3 | Soft 404 for unknown/draft product URLs (200 + noindex) | P1 | `noindex` already emitted | 6 |
| D-4 | Hero carousel pause control; failing a11y test | P1 | None needed for trading | 6 |
| D-5 | Content-Security-Policy | P1 | Baseline headers in place | 10 |
| D-6 | `AUTH_SECRET` ≥ 32 enforced in code | P1 | Owner sets ≥ 32 (checklist) | 10 |
| D-7 | `proxy.test.ts` never runs (top-level await) | P1 | Route gating verified over HTTP in this release | 11 |
| D-8 | 22 lint errors; theme/campaigns tests | P2 | None | 11 |
| D-9 | Reservation expiry for unpaid pending orders | P1 | Cancel abandoned orders daily | 4 |
| D-10 | Email/SMS notifications; OTP phone verification | P1 | Manual contact; operator password command | 7/9 |
| D-11 | bKash, online balance/full, Nagad | P2 | COD + manual wallet claim | 7 |
| D-12 | Steadfast live verification; Pathao/RedX | P1 | Manual courier entry | 8 |
| D-13 | Free-delivery coupon; manifest/PWA (minimal name-only manifest done in Phase 1; icons/installability remain); share image (owner asset) | P2 | — | 9 |
| D-14 | Product/variant redesign; combo/box redesign; admin and storefront redesigns | P2 | Current engines work | 2, 3, 5, 6 |
| D-15 | Enum value order of `PaymentStatus`/`PaymentMethod` differs from the Prisma declaration order (cosmetic; sets equal) | P2 | None | 10 |
| D-16 | Browser E2E, load test, restore drill, production-copy rehearsal | P1 | Owner smoke test and backup in checklist | 11 |
