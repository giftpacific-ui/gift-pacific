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

## Next phase: P3 — Meta Pixel, Conversions API, GA4, GTM and complete ecommerce tracking
