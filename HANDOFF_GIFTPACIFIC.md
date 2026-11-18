# Gift Pacific — Handoff

## P1 — Branding cleanup + storefront polish (completed, with limits below)

### Completed
- Removed handmade/clay/craft brand positioning from customer-facing copy: site description (`siteConfig`), home metadata + default hero, hero fallback, story band, trust section, About page (rewritten, no invented history/claims), shipping/returns intro, cart empty state, boxes, contact, nav/footer label ("Our story" → "About us"; route `/about-us` unchanged).
- `ProductBadge.HANDMADE` kept: enum, admin option and "Handmade" label remain as a valid per-product attribute. No schema/data change. Not verified against live data (no DB access).
- Branding guard extended (`CONTENT_PATTERNS`): flags obsolete craft-positioning phrases only in customer-facing code (`src/app|components|features|config|lib`, `prisma/seed*`; admin and migrations excluded). Bare "handmade" is intentionally not flagged. Test added in `tests/unit/branding-guard.test.ts`.
- UI consistency: outlier radii (`rounded-xl/2xl/3xl`) normalised to the site's `rounded-[4px]` on hero image, boxes list/detail, home boxes + campaign sections, combo builder, shipping table; removed the tilted "polaroid" story image; softened box-card hover (no lift).
- Admin: inspected layout/sidebar — already has breadcrumbs, mobile sheet menu, `aria-current`, skip target. No change made; no permissions/workflows touched.

### Changed files
src/config/site.ts · src/app/(shop)/{page,about-us/page,boxes/page,boxes/[slug]/page,cart/page,contact/page,shipping-returns/page,build-your-own-combo/page}.tsx · src/features/home/{hero,story-band,trust-sections,active-boxes-section,active-campaign-section}.tsx · src/components/layout/{navbar,footer,mobile-nav}.tsx · src/app/globals.css (comment only) · scripts/check-branding.mjs · tests/unit/branding-guard.test.ts · HANDOFF_GIFTPACIFIC.md

### Content that should be admin-editable (not built in P1)
- Already admin-managed: hero slides (Banner, HERO placement), campaigns, boxes, team, store name/logo/social/contact/shipping settings.
- Still hard-coded: homepage story band, trust/"why choose us" points, About body, shipping & returns, privacy/terms, default hero fallback, homepage/static page metadata. No static-page CMS model exists; adding one needs an additive Prisma migration — recommend doing it with P2's Page SEO record.

### Remaining issues
- Shipping page states "3–7 business days" delivery and a 3-day damage-report window: pre-existing promises, left unchanged — merchant must confirm or make editable.
- Bangla `siteConfig.description` rewritten by me; have a native speaker review.
- Admin tooltips/attribute hints mention "handmade" as an example (valid generic attribute).
- Visual polish was done by code inspection only; no browser/responsive check was possible.

### Verification (exact)
- `node scripts/check-branding.mjs`: PASS.
- Syntax parse (TypeScript `transpileModule`) of 32 edited files: 0 errors. This is NOT a type check.
- `tsc --noEmit`, ESLint, `pnpm test`, `next build`: NOT RUN — no node_modules, no network/pnpm. BLOCKED.
- New guard unit test: NOT RUN via test runner; the guard logic was checked manually on a temp repo (flags clay/handmade-with-care in features/home, ignores admin).

### Known issues carried from P0
Future-dated migrations (20261117–19…), unverified Meta CAPI/Steadfast contracts, no runtime verification.

---

## P2 — Dynamic admin-controlled SEO (implemented; NOT type-checked/built/run against a database)

### Architecture (one system, reused)
- `src/lib/seo.ts` (`buildPageMetadata`) stays the single metadata builder; extended with origin, canonical override, OG title/description, Twitter card, nofollow, robots directives.
- `src/server/services/seo.service.ts` `pageMetadata(seo, {systemKey?, override?})` is the only server entry. Precedence per field: **admin override (Page SEO row / product / category / box / CMS page) > route's data-derived default > global settings**. `getStoreSettings` + `getAllPageSeo` (one query) are request-cached; public pages keep existing `revalidate`; every SEO save calls `revalidatePath("/", "layout")` + sitemap/robots.
- Pure, unit-tested rules (no server imports): `lib/seo-rules.ts` (canonical safety, robots directives/robots.txt rules, fallback resolution, audit, duplicates, sitemap eligibility), `lib/seo-pages.ts` (system pages, reserved slugs), `lib/redirect-rules.ts`, `lib/seo-validate.ts` (all form validation), `lib/seo-cms.ts`.
- Global noindex cannot be undone by a page. Canonical overrides: same-host only, query/hash dropped. Robots directives: allowlist only.
- Existing product/category/box SEO fields reused (metaTitle/metaDescription/metaKeywords/seoImage/seoNoIndex; box seoTitle/...). Added only what was missing.

### Database (additive migration `20261120000000_seo_management_p2`, sorts after the 17/18/19-Nov migrations)
- StoreSettings: seoDefaultTitle, seoOgTitle, seoOgDescription, seoTwitterCard, seoCanonicalBaseUrl, seoDefaultNoIndex, seoDefaultNoFollow, seoRobotsExtra, seoOrgSchemaEnabled, seoWebsiteSchemaEnabled.
- Product.seoCanonicalUrl; Category.seoImage/seoCanonicalUrl; Box.seoImage/seoNoIndex/seoCanonicalUrl.
- New tables: `PageSeo` (key-unique SEO for built-in routes), `StaticPage` (CMS; `systemKey` for about-us/privacy/terms/shipping-returns), `Redirect`.
- Rollback notes are in the migration header. No existing data touched.
- Verified: the three future-dated migrations (20261117–19…) add only GatewayRefund-related columns and every one of those columns exists in schema.prisma once; no edits made to them. Order is `sort -c` clean.

### Admin (all under the guarded dashboard layout; every action calls `requireAdmin()` first)
`/admin/seo` Overview · `/settings` Global · `/pages` Page SEO (11 built-in routes) · `/products` `/categories` `/boxes` (search, filter, pagination, edit dialog + Google/social preview) · `/static-pages` (+ `/new`, `/[id]`, rich-text editor, preview, publish/unpublish, order, footer link) · `/redirects` · `/technical` (sitemap & robots status). Actions: `src/server/actions/admin-seo.actions.ts`. Nav entry "SEO". No new API routes.

### Public
- `/pages/[slug]` serves published CMS pages (WebPage + BreadcrumbList JSON-LD). System-keyed pages never serve under /pages (no duplicate URL).
- **Existing pages preserved:** about-us, privacy, terms, shipping-returns keep their built-in content until an admin publishes non-empty replacement content; deleting the override restores the built-in text. Nothing was migrated or deleted. Built-in text is NOT auto-imported into the CMS (admin pastes it).
- Footer lists published CMS pages flagged "Link from the footer".
- sitemap: pages/categories/boxes/CMS pages use configured origin; excludes noindex, canonical-elsewhere, private routes, drafts; products likewise. robots.txt is dynamic from settings (private paths always blocked; essential routes protected; rejected rules reported on save and in Sitemap & robots).
- Redirects: handled in `src/proxy.ts` via an in-memory map (30 s TTL, fails open). 301/302, same-site destinations only, loops/chains validated.
- JSON-LD: Organization/WebSite (home) are toggleable and use the configured origin; no ratings/reviews/availability invented.

### Env
No new variables. `NEXT_PUBLIC_SITE_URL` remains the fallback when "Canonical base URL" is blank. Run `prisma migrate deploy` then `prisma generate`.

### Tests
Added: `tests/unit/{seo-rules,seo-pages,redirect-rules,seo-validate,seo-metadata,seo-admin-guard}.test.ts`, `tests/services/seo-sitemap.test.ts`; updated `sitemap-index.test.ts` (robots is now async) and `tests/setup/fake-db.ts` (new tables, `_max`).
See "Results" in the P2 completion report for exact outcomes. `pnpm install`, `tsc`, ESLint, `next build`, `prisma validate/migrate`, and the Playwright/e2e suite were NOT run (no dependencies/network/database here).

### Unverified / risks
- Never compiled: expect possible type errors, especially Prisma `groupBy(... having ...)` in `admin-seo.service.ts` and the loosely typed `Delegate` adapter. First command next session: `pnpm install && pnpm prisma generate && pnpm exec tsc --noEmit && pnpm lint && pnpm test`.
- Prisma inside `src/proxy.ts` (Node runtime in Next 16) is unverified; if the build rejects it, move redirect resolution to a route handler/`next.config` rewrite.
- Existing `proxy.test.ts` and `sitemap-index.test.ts` (needs next.config / real next/server) could not run here.
- (Fixed in the P2 audit fix below: JSON-LD now uses the configured origin.)
- Store-settings "Site & SEO" tab still edits the same four columns (title template, description, keywords, OG image); it now links to the SEO manager. Consider removing it.
- Redirect cache clears instantly only on the saving instance (others ≤30 s).
- Rich-text editor/sanitizer are the pre-existing ones (no images/tables in CMS content).
- No fake scores, rankings or Google-status claims anywhere; previews are labelled estimates.

---

## P2 audit fix (4 verified issues)

1. **Built-in CMS page SEO.** `pageMetadata()` now merges, for About/Privacy/Terms/Shipping & Returns, the published replacement's SEO fields (`mergeSeoOverrides` in `lib/seo-rules.ts`) over the Page SEO row, then route default, then global. Blank CMS fields fall through; noindex/nofollow are ORed. "Replacement exists" = published AND has visible text (`hasRenderableText`, single definition shared by body, metadata and sitemap via `getPublishedSystemPages`, one query/request). Unpublish, delete or empty content → built-in body + Page SEO exactly as before. The system-page editor shows the SEO fields again (with precedence note). Explicit `override` callers (product/category/box/custom CMS page) are unchanged.
2. **Sitemap.** `getPageSitemapEntries` applies the same merge, so a published replacement's `noIndex` or off-page `canonicalUrl` removes the built-in URL; unpublished/empty replacements are ignored; ordinary CMS pages query unchanged (`systemKey: null` made explicit); final de-duplication by URL.
3. **Canonical origin.** `ProductLd.origin` / `collectionPageJsonLd({origin})` added; product page and shop page pass `getCanonicalOrigin()` to product, collection and breadcrumb JSON-LD, and shop canonical (`shopSeo.siteUrl`) uses it too. Canonical tag, OG URL, sitemap, robots sitemap line and JSON-LD now share one origin. Still env-origin by design: payment callback URLs, admin integration URL displays, admin product-form URL hint (not SEO output).
4. **Migration.** schema.prisma declares `keywords` / `seoKeywords` as required lists; the P2 migration created nullable `TEXT[]` (same form as older repo migrations). Whether P2 was already applied is unknowable offline, so the P2 migration is **untouched** and a follow-up `20261121000000_seo_keywords_not_null` backfills NULL → `{}` then sets default + NOT NULL on both columns (idempotent, no deletes). Older list columns (Product.metaKeywords etc.) keep the repo's nullable convention and were not touched.

### Verification of the audit fix
Executed here (Node 22 + a temporary alias loader and stand-ins for `react`/`clsx`/`tailwind-merge` kept outside the repo):
- Pure unit tests: 50/50 pass (`tests/unit/seo-*.test.ts`, `redirect-rules`, `branding-guard`, incl. new `seo-origin-and-migration.test.ts`, merge test in `seo-rules.test.ts`).
- Fake-DB service tests: 14/14 pass (`tests/services/seo-p2-fixes.test.ts` new, `seo-sitemap.test.ts`).
- `node scripts/check-branding.mjs`: PASS.
Static only: TypeScript syntax parse of 81 changed files, 0 errors (not a type check); source-text assertions in the tests above.
Blocked (no dependencies): `tsc --noEmit`, ESLint, `next build`, full `pnpm test`, existing `proxy.test.ts` / `sitemap-index.test.ts`, e2e.
Database checks NOT performed: `prisma validate`, `migrate deploy`, running the new migration on real rows, `prisma migrate diff` for drift, Prisma `groupBy ... having`, Prisma inside `src/proxy.ts`. The fake DB only approximates Prisma filters.

### Required before calling P2 verified
`pnpm install && pnpm prisma generate && pnpm exec tsc --noEmit && pnpm lint && pnpm test`; on a disposable Postgres: `prisma migrate deploy`, then `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url ...` (expect empty); `next build`; spot-check about-us/privacy/terms/shipping-returns metadata + `/sitemap/0.xml` with a published replacement set to noindex.

## P3 — Tracking: Meta Pixel + Conversions API, GA4/GTM, attribution, consent (implemented; NOT type-checked in full / built / run against a database or Meta/Google)

### What was found (existing system, extended not rebuilt)
`src/lib/analytics/*` already loaded GTM/GA4, Meta Pixel, TikTok and LinkedIn behind an `OFF` / `OPT_IN` consent mode, and `submitCheckout` sent a server Purchase. Defects fixed:
1. **Purchase fired on order creation** (server CAPI in `submitCheckout` AND browser on the confirmation page), whatever the order status.
2. **GA4 direct mode (`G-…`) never received ecommerce events**: they were plain-object `dataLayer` pushes, which gtag.js ignores (only GTM reads them). Not verified live; confirm in GA4 DebugView.
3. `pushToDataLayer` had **no consent check**: events pushed before consent would be replayed by GTM once it loaded.
4. Graph API **`v20.0` hard-coded** (published deprecation 2026-09-24).
5. `AddPaymentInfo` fired on page load with no items/value; `InitiateCheckout` omitted quantities; the order confirmation sent no items/tax/shipping/coupon.
6. Server events under `OPT_IN` were never sent (the server could not see consent).

### Purchase trigger policy (chosen from the existing workflow, not invented)
A website order's Purchase is generated when the order **enters `CONFIRMED` through `adminUpdateOrderStatus`** (admin action or courier sync). `PENDING→CONFIRMED` is the only way into `CONFIRMED`, and that function already refuses to confirm an order whose required advance is not VERIFIED/waived or whose low-trust review is open. COD and prepaid follow the same rule. It does not wait for delivery.
- Never a Purchase: PENDING orders; non-website channels (marketplace/external, which bypass checkout); orders CANCELLED / REFUND_REQUESTED / REFUNDED / FAILED_DELIVERY at delivery time (a waiting event is SKIPPED).
- An already-accepted Purchase is **not reversed** if the order is later cancelled (no standard "un-purchase" event); the audit row shows what was sent.
- Exactly once: unique `(destination, eventName, orderId)` row + `createMany skipDuplicates`; event id `purchase_<orderNumber>` (`ids.ts`, single definition) is shared by browser and server so Meta de-duplicates.
- Browser Purchase (Meta Pixel, and GA4 only when the server does not own GA4 - see P3.1) fires only if the order is **already confirmed when the customer views the confirmation page** (`purchaseEligibility`); once per order per browser.

### Architecture
- `lib/analytics/purchase-policy.ts` eligibility, consent decisions, retry schedule (pure).
- `lib/analytics/server-events.ts` (rewritten in place; `trackServerEvent` removed) CAPI client: normalise+SHA-256 hashing, payload, send with 5 s timeout, failure classification, redaction.
- `server/services/tracking-event.service.ts` enqueue → claim → re-read order → checks → send → SENT / retry / FAILED / SKIPPED; maintenance job (back-fill, re-queue "not configured", deliver due, scrub); admin retry.
- Hook: `adminUpdateOrderStatus` calls `trackOrderConfirmed` **after** the transaction commits (**P3.1: it now only persists the events and returns; delivery is background-first** - see the P3.1 section; never throws).
- `lib/analytics/attribution.ts` + `attribution-capture.tsx` (cookie `gp_attr`) + `server/services/order-attribution.service.ts` (snapshot at checkout).
- `lib/analytics/payloads.ts` (pure builders), `tracking-state.ts` (consent gate + GA4 mode routing), `events.ts` (public API; PageView stays with the snippets/RouteChangeTracker).
- `server/services/tracking-diagnostics.service.ts`, `features/admin/tracking-diagnostics-panel.tsx` (on **Admin → Settings**), `server/actions/tracking.actions.ts`, `app/api/tracking/retry/route.ts`.
- Removed (dead, un-gated): `meta-pixel.ts`, `pushToDataLayer`, `fireTikTokEvent`, unused `trackPageView`.

### Events
PageView (snippets + route changes), ViewContent, Search, AddToCart, RemoveFromCart (GA4 `remove_from_cart`; Meta **custom** event), AddToWishlist (needs the optional `tracking` prop on `WishlistButton`), InitiateCheckout, AddPaymentInfo (on valid submit), Lead (contact form), CompleteRegistration (register form), Purchase. Each carries a unique event id, BDT, value, `content_ids`, `content_type`, `contents[{id,quantity,item_price}]`; Purchase adds `order_id`/`transaction_id`, tax, shipping, coupon. GA4 purchase `value` = total − shipping − tax (items net of discount), a documented choice, not verified against GA4 requirements; Meta `value` = order total. Product id is used as content id / item id; if the Meta catalogue uses SKUs, change `itemId` in `payloads.ts`.
CAPI server events cover **Purchase only**. `event_source_url` = `<origin>/checkout` (never contains the order number); `action_source` is `website` only when a user agent was captured, else `other`.

### Attribution
Captured on the first eligible landing (campaign signal or external referrer; a direct first visit is stored as a direct first touch): utm_source/medium/campaign/content/term, campaign_id, adset_id, ad_id, placement, fbclid (→ fbc), landing **path** (order numbers masked, no query), referrer **host**. `_fbp`/`_fbc` read at checkout. First touch is never overwritten; last touch updates on eligible landings only; unresolved `{{macros}}` are discarded. The cookie is client-controlled, so the server re-validates every field (numeric ids, fbc/fbp formats, sane timestamps, length caps, markup stripped) and stores a snapshot once per order (`OrderAttribution`, first/last touch JSON). Attribution is reporting/matching data only and never affects value or totals. No separate session/customer attribution table: association is order → userId. Under `OPT_IN` without a grant only the consent state is stored. IP and user agent are kept only for CAPI matching and set to NULL after delivery or 8 days.

**Recommended Meta Ads URL parameters** (Ads Manager → ad → URL parameters):
```
utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}
```

### Consent (policy documented, default NOT changed)
`consentMode` default stays `OFF`: trackers load with no banner and the merchant carries the legal responsibility. Under `OPT_IN`: nothing loads or is sent until "granted"; events before consent are **dropped, never replayed**; the choice is mirrored to cookie `gp_consent` and snapshotted on the order. Server delivery: OFF → sent unless that order recorded an explicit denial; OPT_IN → sent only with a recorded grant (the **current** mode judges the stored snapshot). Withdrawal clears `_fbp`, `_fbc`, `_ga*`, `_gcl_*`, `_tt*` and `gp_attr` and stops further events. Behaviour change: under OPT_IN, server Purchases are now sent for orders placed with a grant (previously never). (P3 limit "withdrawal after checkout is not linked to the order" is **fixed in P3.1**.)

### Database (additive migration `20261122000000_tracking_p3`)
Enums `TrackingEventStatus`, `TrackingConsentState`; tables `TrackingEventLog` (no customer data: status, attempts, order number, sanitized error, fbtrace id; unique per order+event) and `OrderAttribution`. No existing table/column changed. Rollback documented in the file. Never applied to a database.

### Environment
`META_CONVERSIONS_API_TOKEN` (server only, existing), `NEXT_PUBLIC_META_PIXEL_ID` or the admin Pixel ID (existing), `NEXT_PUBLIC_GTM_ID` or admin Google ID (existing), `CRON_SECRET` (existing; ≥24 chars enables `/api/tracking/retry`), new optional `META_GRAPH_API_VERSION` (default `v25.0`, unverified against live Meta) and `META_CAPI_TEST_EVENT_CODE` (remove in production; production-checks and diagnostics warn).

### Setup
**Meta:** create the Pixel; Events Manager → Settings → Conversions API → generate an access token → `META_CONVERSIONS_API_TOKEN`; set the Pixel ID in Admin → Settings; schedule `POST /api/tracking/retry` every 5–15 min with `Authorization: Bearer $CRON_SECRET`; test with `META_CAPI_TEST_EVENT_CODE`, then remove it. **GA4/GTM:** put either a `G-…` id (direct gtag.js; ecommerce via `gtag('event')`) or a `GTM-…` id (events arrive as `{event, event_id, ecommerce}`; the container needs GA4 event tags on those custom events and, for SPA page views, a History Change trigger). Use only one: do not also load the same GA4 stream inside GTM.

### Tests (executed with Node 22 + temporary loader and stand-ins outside the repo; zod 3.25 stand-in for 4.5.4)
New: `tracking-payloads` (6), `tracking-attribution` (9), `tracking-capi` (14), `tracking-client-gate` (10), `tests/services/tracking-event` (18, real `placeOrder`→confirm flow), `tracking-settings` updated (6). All pass. Mutation checks (re-allow PENDING, drop dedupe, drop consent check) each made tests fail. Full suite: 778 pass / 28 fail vs original 680 / 30; **no test fails that did not already fail in the original** (all traced failures = packages missing in the sandbox: clsx, slugify, jose, bcryptjs). `advance-hardening` and `reviews` fail in the original but pass here for a reason not investigated. `node scripts/check-branding.mjs` passes. Strict `tsc` (TS 6.0.3) over the dependency-light changed files is clean (it caught one narrowing bug, fixed).
**BLOCKED:** full `tsc` (TSX components and Prisma-typed services never type-checked), ESLint, `prisma validate`, `next build`, applying the migration, any call to Meta or Google, e2e.

### Known limitations / remaining (P3; items 1, 3 and the withdrawal limit were resolved in P3.1, see below)
- ~~GA4 purchase is browser-only~~ resolved in P3.1 (server-side Measurement Protocol).
- Server CAPI/GA4 cover **Purchase only**; other events are browser-only (P3.1 documents a safe future approach).
- ~~Confirmation waits up to ~6 s~~ resolved in P3.1 (background-first).
- Test-fixture changes: `fake-db` (2 tables, 1 relation, 2 uniques) and a `headers()` export in the `next/headers` stub.

### Manual production verification
1. `pnpm install && pnpm prisma generate && pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build`; on a disposable Postgres `prisma migrate deploy` then `prisma migrate diff` (expect empty).
2. With `META_CAPI_TEST_EVENT_CODE`: place an order (nothing in Test Events), confirm it in admin (exactly one Purchase, `event_id` = `purchase_<orderNumber>`, matched by the browser event if the customer views the confirmation page, shown as deduplicated).
3. Admin → Settings → Tracking diagnostics: statuses correct, no secrets; break the token and confirm a FAILED row with a safe message, then fix and Retry.
4. GA4 DebugView: view_item, add_to_cart, remove_from_cart, begin_checkout, add_payment_info, purchase (items, transaction_id, tax, shipping).
5. OPT_IN store: no tracker requests before consent; withdraw consent and check cookies are cleared.
6. Open an ad URL with the template above and confirm `OrderAttribution` after an order.

## P3.1 — GA4 Measurement Protocol purchase, consent withdrawal, background delivery (implemented; same BLOCKED checks as P3)

### Delivery policy (one reliable sender per destination)
| Destination | Sender | Notes |
|---|---|---|
| **GA4 `purchase`** | **Server only** (Measurement Protocol) when `GA4_API_SECRET` is set; the storefront then **omits** the browser GA4 purchase (`serverSendsGa4` → `purchaseEvent(..., {includeGa4:false})`). If the secret is not set, the browser sends it as in P3 (only when the order is already confirmed at page view). | Google's docs describe **no** de-duplication between browser and Measurement Protocol events, so exactly one sender is the only safe policy. In validation mode (`GA4_MP_DEBUG`) nothing is recorded, so the browser keeps sending. |
| **Meta `Purchase`** | Browser Pixel (if already confirmed at page view) **and** server CAPI, de-duplicated by the shared event id `purchase_<orderNumber>`. | unchanged from P3 |
Trigger (unchanged): the order **enters `CONFIRMED`** through `adminUpdateOrderStatus`. One `TrackingEventLog` row per (destination, event, order): destinations `META_CAPI` and `GA4_MP` (the `destination` column was already free text; no enum change).
GA4 specifics (from Google's docs, verified): endpoint `https://www.google-analytics.com/mp/collect?measurement_id=…&api_secret=…` (the **secret is in the URL query by Google's design** - it is redacted from every message/log/stored error and never reaches the browser); `client_id` is required; events may be back-dated at most **72 h** and older ones are *accepted but silently re-dated*, so events older than **71 h are skipped** (`event_too_old`) instead of sent. Payload params come from the **same `purchaseEvent()` as the browser** (transaction_id, currency BDT, `value` = total − shipping − tax, tax, shipping, coupon, items) plus `session_id` (when captured) and `engagement_time_msec:1`; `timestamp_micros` = confirmation time.
**Client id**: read at checkout from the first-party `_ga` cookie (`GA1.x.<random>.<ts>` → `<random>.<ts>`), session from `_ga_<MEASUREMENT>`; both strictly validated, stored on the existing `OrderAttribution` row, **only when consent permits and GA4 server purchase is configured**. No client id ⇒ GA4 event `SKIPPED no_client_id` (never invented; Meta unaffected). Visitors whose browser never ran GA (blocked/no consent) therefore produce no GA4 purchase, consistent with GA4 never having seen them.
Identifiers (IP, user agent, GA client/session id) are erased once **no event of the order can still be delivered** (all SENT/SKIPPED; a **FAILED** event keeps them for an admin retry until the 8-day cleanup - found and fixed during testing), or immediately on consent withdrawal.

### Background delivery architecture (replaces the 6-second wait)
`adminUpdateOrderStatus` (after commit) → `trackOrderConfirmed`: **persists** the PENDING rows (a few fast DB writes) and schedules `after()` (Next's post-response hook) to deliver them; it never waits for Meta/Google. `after()` is only an optimisation: the **guaranteed** mechanisms are (1) the persisted PENDING row and (2) the retry job `POST /api/tracking/retry` (`Authorization: Bearer $CRON_SECRET`; also "Run delivery job now" in admin), which delivers due rows, **recovers crashed workers** (stale `SENDING` claims after 2 min), **back-fills** confirmed orders whose rows were never persisted (from the order's CONFIRMED history row, ≤7 days), re-queues rows skipped as `not_configured` once configured, and erases old identifiers. Idempotency is unchanged (unique row per destination+order, guarded claim). **Without a scheduler** only the single post-response attempt runs, so schedule the job (diagnostics warns when events wait and `CRON_SECRET` is missing).

### Consent withdrawal (fixes the P3 limitation)
- On **grant**, the browser mints an opaque reference (`gp_cref` cookie): 128 random bits from `crypto.getRandomValues`, **not derived from email/phone/order/user data**. Checkout stores it on `OrderAttribution.consentRef` (only when consent permits).
- On **withdrawal** (granted → denied) the browser clears tracking cookies (`_fbp,_fbc,_ga*,_gcl_*,_tt*,gp_attr,gp_cref`) and calls `POST /api/consent/withdraw {ref}` (`fetch` with `keepalive`). A **pending marker** is stored before the request and cleared only on a 2xx, and retried on every page load (offline / reload / 500). A first-time "decline" makes no request.
- Server (`withdrawTrackingConsent`): finds the affected orders by **the reference and/or the signed-in customer's account** (covers guests, and customers withdrawing from another device), then (a) turns every **PENDING / FAILED** event into `SKIPPED consent_withdrawn` (the retry job and the admin Retry cannot send it), (b) marks the attribution `DENIED` + `consentWithdrawnAt` and **erases** touches, fbc/fbp, IP, user agent, GA ids and the reference. It reads/writes **no order, payment or customer record**; orders are never deleted. A delivery that is being prepared re-checks consent **immediately before the request**, so a withdrawal arriving mid-preparation still wins.
- The endpoint is same-origin only (403 otherwise), rate limited (existing limiter, generous), accepts ≤512 bytes, validates the reference (400), answers only `{ok:true}` whether or not anything matched (no order ids, no counts, no probing), and answers 500 on a server error so the browser retries.
- **Already-delivered events (SENT) stay SENT and are NOT recalled**: neither the Meta Conversions API nor the GA4 Measurement Protocol offers per-event deletion, and this code does not claim otherwise. Withdrawal after delivery erases our stored identifiers and prevents any further event; data already at Meta/Google follows their own retention/deletion tools (a deletion request there is a manual process).
- Limits: consent is per browser. A signed-in customer's withdrawal applies to all **existing** orders on their account; an order later placed from another browser carries that browser's own consent. Orders placed before P3.1 (or by visitors who granted before it) have no reference, so a guest withdrawal cannot find them (signed-in customers are still covered by account). A request that raced ahead of the order snapshot insert is not covered (the consent cookie is already `denied` for any later request).

### CAPI/server coverage review (nothing added - by design)
Server-side today: **Purchase** (Meta + GA4). **Browser-only:** PageView, ViewContent, Search, AddToCart, RemoveFromCart, InitiateCheckout, AddPaymentInfo, AddToWishlist, Lead, CompleteRegistration. No second pipeline was built. **Safe future approach** for server ViewContent / AddToCart / InitiateCheckout: (1) the browser already generates a per-occurrence `eventId` for every event (`newEventId`) and passes it to `fbq(..., {eventID})`; relay the **same id** to a same-origin endpoint so Meta de-duplicates browser+server by `event_id`+`event_name`; (2) the endpoint accepts only `{eventName, eventId, productId(s), quantity}`, **re-derives price/currency/name from the catalogue** (never trusts client values), and rate-limits; (3) consent: require `gp_consent=granted` (OPT_IN) at request time and reuse the `gp_cref` reference so a withdrawal also drops queued relays; (4) user data only from first-party cookies already used here (`_fbp/_fbc`, IP, UA - raw as Meta requires) with email/phone only for logged-in checkout events, hashed as in `server-events.ts`; (5) persist via the same `TrackingEventLog` + retry job with a new `eventName`, keeping one lifecycle. Do this only if measured match quality justifies the extra endpoint; it needs its own phase and tests.

### Environment (new in P3.1)
`GA4_API_SECRET` (**server only, secret**; GA4 Admin → Data streams → web stream → Measurement Protocol API secrets), `GA4_MEASUREMENT_ID` (optional, public; needed when GA4 is loaded through a GTM container), `GA4_MP_DEBUG=true` (optional validation mode: Google reports problems, **nothing is recorded**, event shown as `SKIPPED validation_only`; production-checks and diagnostics warn). `CRON_SECRET` (≥24 chars) is now needed for GA4 too. Admin → Settings → Tracking diagnostics shows GA4 server state, backlog age and per-destination failures (secrets never shown).

### GA4 Measurement Protocol setup
1. GA4 Admin → Data streams → web stream → note the Measurement ID (`G-…`) → create an API secret → set `GA4_API_SECRET`. If the storefront uses a GTM container, also set `GA4_MEASUREMENT_ID`.
2. Optionally set `GA4_MP_DEBUG=true`, place and confirm a test order, read the result in the admin panel (a valid event shows `SKIPPED validation_only`), then remove it.
3. Schedule `POST /api/tracking/retry` with the bearer secret. 4. Verify in GA4 Realtime/DebugView (below).

### Migration `20261123000000_tracking_p31` (additive)
Four nullable columns on `OrderAttribution` (`gaClientId`, `gaSessionId`, `consentRef`, `consentWithdrawnAt`) + index `OrderAttribution_consentRef_idx`. No table created, nothing altered/dropped/rewritten. Rollback in the file. **Never applied to a database** (no Prisma/DB available); the schema↔migration consistency of all 36 tracking columns is checked statically by `tests/unit/tracking-ga4.test.ts`, which is not a substitute for `prisma validate` / `migrate diff`.

### Files changed in P3.1
New: `lib/analytics/{ga4-mp,consent-ref}.ts`; `server/services/consent-withdrawal.service.ts`; `app/api/consent/withdraw/route.ts`; migration; tests `tests/unit/{tracking-ga4,consent-client}.test.ts`, `tests/services/{tracking-p31,consent-withdraw-route}.test.ts`.
Changed: `schema.prisma`; `lib/analytics/{attribution,consent,purchase-policy,payloads,events,attribution-capture}`; `server/services/{tracking-event,tracking-diagnostics,order-attribution}.service.ts`; `features/checkout/track-purchase.tsx`, confirmation page; `features/admin/tracking-diagnostics-panel.tsx`; `lib/{env,production-checks,rate-limit}.ts`; `.env.example`; test fixtures (`next-server` `after()`, `prisma-client` `Prisma.DbNull`, `helpers` `drainAfter`); P3 tests adapted for background delivery (confirm no longer delivers inline).

### Tests (P3.1)
Executed with the same temporary Node loader/stand-ins as P3 (zod 3.25 stand-in). New: `tracking-ga4` (13), `tracking-p31` (20, real confirm flow), `consent-withdraw-route` (5), `consent-client` (6, real client module against emulated cookies/localStorage/fetch); all pass, as do the 63 adapted P3 tests. Covered: GA client-id capture/validation, GA4 payload, GA4 idempotency, browser-XOR-server single sender, guest and authenticated withdrawal, withdrawal before delivery / after delivery / of FAILED events / mid-preparation, background recovery (after() never ran, crashed claim, persist failure + back-fill), Meta and GA4 failures independent, no secret in any stored row. **Mutation checks** (5): keep browser GA4, withdrawal skips nothing, no late consent re-check, await delivery again, FAILED treated as settled - each made tests fail. A real bug found and fixed by the tests: identifiers were erased while a FAILED destination still needed them.
Full suite: **880 tests, 822 pass, 28 fail**; the same 28 as P3 (packages missing in the sandbox: clsx, slugify, jose, bcryptjs), **no failing test that was not already failing in the original**.
Strict `tsc` (TS 6.0.3): clean on 12 dependency-light files and, with Prisma/Next imports shimmed as `any`, on the server services and routes (verified it can fail). **BLOCKED:** real full `tsc` (TSX components and Prisma-typed field names), ESLint, `prisma validate`, `next build`, applying the migration, any real call to Meta/Google, e2e.

### Production verification (P3.1)
1. `pnpm install && pnpm prisma generate && pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build`; on a disposable Postgres `migrate deploy` then `migrate diff` (expect empty).
2. Set `GA4_API_SECRET` (+ `GA4_MEASUREMENT_ID` if GTM) and `GA4_MP_DEBUG=true`; place + confirm an order; the admin panel must show GA4 `skipped (validation only)` with no validation errors. Remove `GA4_MP_DEBUG`.
3. Place a COD order (visit the site first so `_ga` exists), **do not** revisit the confirmation page, confirm it in admin: the admin click must return immediately; within seconds (or the next job run) GA4 Realtime/DebugView shows one `purchase` with the order number as `transaction_id`; Meta Events Manager shows one Purchase. Revisit the confirmation page: GA4 must NOT receive a second purchase.
4. Break `GA4_API_SECRET`: a failed row with a safe message appears and is retried; fix and press Retry.
5. OPT_IN store: grant consent, place an order (do not confirm), withdraw consent, confirm the order in admin: both events must show `skipped (consent withdrawn)`, nothing reaches Meta/GA4, the order is intact. Repeat as a logged-in customer from a second browser. Withdraw while offline and reload: the request is retried.
6. Stop the scheduler and confirm an order: the post-response attempt still delivers; with the attempt interrupted, the next job run delivers it.

### Next phase
Run the verification above. P4 was not started.
