# HANDOFF — GIFT PACIFIC

**This is the only authoritative handoff for the project.** It replaces every earlier handoff, README, changelog, verification note and `docs/*.md` file, all of which were consolidated here in Phase 1 (rebrand + cleanup) and deleted. `AGENTS.md` (loaded through `CLAUDE.md`) holds the permanent working rules for AI sessions.

**Status vocabulary used throughout** (a feature is never called "working" just because code exists):

| Label | Meaning |
|---|---|
| **Implemented in source** | The code exists in the repository. |
| **Verified by tests** | Executed by the automated suite in a *fake in-memory database* (not real PostgreSQL). Proves rules and logic, not SQL behaviour. |
| **Partially implemented** | Some of the required behaviour exists; the gaps are listed. |
| **Missing** | Not built. |
| **Known broken** | A defect or failing check that is reproducible. |
| **Not verified in a real environment** | Never run against real PostgreSQL, a real browser, or a real third-party API. |

> **Emergency production release (see `RELEASE_AUDIT.md`, `RELEASE_CHECKLIST.md`, `MASTER_ROADMAP.md`):** the source-level work is finished, but **the release is NOT cleared for production**. Blockers that only the owner can clear: production migration checksum check (BLOCKED), production environment/advance-policy confirmation (OWNER ACTION REQUIRED), a genuine `pnpm build` on a host with Google Fonts access (UNVERIFIED), post-deployment smoke tests. One real P0 defect was found and fixed (homepage returned HTTP 500 when no Campaign banner was active). Verified on real PostgreSQL 16: all 28 migrations apply to an empty database; the 24 integration tests pass; 12 release scenarios (checkout, oversell race, duplicate submit, cancel/restore, advance gate, payment-reference uniqueness, authorization, ownership) pass; HTTP smoke of the built app (with mocked fonts) shows 200/307/401 as expected and the new security headers. **Not verified anywhere:** production database/checksums, a real browser, bKash, Steadfast, GTM/Pixel, Cloudinary.
>
> **Documents in the project:** this handoff (project knowledge), `MASTER_ROADMAP.md` (authoritative Phase 0–11 plan with real statuses), `RELEASE_AUDIT.md` (issue register and evidence), `RELEASE_CHECKLIST.md` (owner deployment, migration check, smoke tests, rollback), `AGENTS.md`/`CLAUDE.md` (working rules).

---

## 1. Project identity and business context

- **Human name:** Gift Pacific. **Technical identifier:** `giftpacific`. **Package name:** see `package.json`.
- **Business:** a Bangladesh-focused e-commerce store selling handmade clay art, personalised gifts, gift boxes and combo packs. Currency BDT (৳). Cash on Delivery is the main payment method; an advance (partial prepayment) is required for some delivery zones. Couriers: Steadfast (the only integrated one). Phone numbers are Bangladeshi mobile numbers (`01XXXXXXXXX`).
- **Owner-operated.** No email provider exists (customers track orders on the site; there is no transactional email).
- **Active brand: Gift Pacific.** Never reintroduce the discontinued brand (see §1.1). The guard `pnpm check:branding` enforces this.
- **Language/locale:** English UI with Bangla-capable fonts (Cormorant headings, Manrope body, Noto Serif Bengali as the Bengali fallback; **owner decision: Hind Siliguri was removed on purpose and Cormorant Garamond is not used — never re-add either**); Bangladesh time for campaign dates.

### 1.1 Branding state after Phase 1

Done in Phase 1:
- Old-brand text removed from code, tests, configuration and documentation.
- The two old image assets (`public/images/logo.png`, `src/app/favicon.ico`) were **deleted**. **No Gift Pacific logo or favicon exists in the repository.** `siteConfig.logoUrl` is `""`; the storefront, admin, invoices, loading screen and structured data fall back to the **text store name**. **Action for the owner: supply Gift Pacific logo/favicon assets** (upload both in **Admin → Settings**: the logo and the favicon fields, stored as `StoreSettings.logoUrl` / `faviconUrl`; `src/app/layout.tsx` applies the favicon through metadata only when `faviconUrl` is set. No `src/app/favicon.ico` exists any more, so until a favicon is uploaded browsers request `/favicon.ico` and get a 404). Nothing was invented.
- **Phase 1 completion pass (evidence in §19.1c).** (a) `src/app/loading.tsx` still pointed at the deleted `/images/logo.png`, so with no logo set the loading screen rendered a broken image (contrary to the sentence above); it now renders the image only when `StoreSettings.logoUrl` exists and the text store name otherwise (CRLF line endings kept). (b) A minimal web manifest was added (`src/app/manifest.ts`, see §18 SEO). (c) **Default social-share image:** none exists. `src/app/layout.tsx` emits Open Graph/Twitter images only when `StoreSettings.ogImageUrl` is set; `pageMetadata` falls back to `ogImageUrl`, then `logoUrl`; a product/page with its own image always wins (`buildPageMetadata`). **OWNER ASSET REQUIRED:** an official default share image (about 1200×630 JPG/PNG), then paste its https link in **Admin → Settings → Site & SEO → "Default share image link"**. (d) **Production store name is UNVERIFIED:** source defaults (schema, `init` migration, `siteConfig`) are all `Gift Pacific`; the seed does not write `StoreSettings`; the migration-22 rename is a no-op (§6.2). Owner check: **Admin → Settings → General → Store name** must read `Gift Pacific`, or the read-only `SELECT "storeName" FROM "StoreSettings";` (`RELEASE_CHECKLIST.md` §6.2 check 4). (e) The order-number prefix `AP-` remains an **owner decision pending**; nothing about order numbers was touched.
- Technical identifiers renamed **with read-through compatibility** (old values are still read, never written):

| Purpose | New | Legacy (read only) | Where |
|---|---|---|---|
| Analytics consent (localStorage) | `giftpacific_consent_v1` | the pre-rebrand consent key | `src/lib/analytics/consent.ts` (copied once to the new key) |
| Consent change event | `giftpacific:consent-changed` | – | same file |
| Guest order-confirmation cookie (24 h, httpOnly) | `giftpacific_order_conf` | `ap_order_conf` | `src/lib/confirmation-cookie.ts`, `src/server/confirmation.ts` | <!-- branding-guard:allow -->
| Purchase-event de-dup (localStorage) | `giftpacific_purchase_tracked_<orderNumber>` | `ap_purchase_tracked_<orderNumber>` | `src/features/checkout/track-purchase.tsx` | <!-- branding-guard:allow -->
| Promo popup once-per-session (sessionStorage) | `giftpacific_popup_<bannerId>` | `ap_popup_<bannerId>` | `src/features/home/promo-popup.tsx` | <!-- branding-guard:allow -->

  The legacy lines are marked `branding-guard:allow`. They can be deleted after at least 30 days in production (cookie 24 h; session storage ends with the tab; localStorage keys persist, so the longest-lived compatibility is consent and purchase-tracking).
- Session cookies (`session`, `admin_session`), the guest cart cookie and cache tags carry no brand and were **not** changed, so no customer or admin session is invalidated.

<!-- branding-guard:allow-start -->
**Intentionally retained historical references** (these are the only ones; the guard allows them):

1. **Migration directory `prisma/migrations/20261113000000_brand_default_aura_petals`** — the folder name is the applied migration's identity in `_prisma_migrations`. It must never be renamed. The whole `prisma/migrations/` tree is excluded from the guard.
2. **Legacy compatibility literals** listed in the table above (`aura_consent_v1`, `ap_order_conf`, `ap_purchase_tracked_`, `ap_popup_`) in the five marked source/test lines.
3. **This section and §6.2** of this handoff, which must name the old brand to explain the migration and database actions (inside `branding-guard:allow` blocks).

**The order-number prefix `AP-`** (e.g. `AP-202610-000123`) is derived from the old brand's initials. **Owner decision (Phase 1): keep it unchanged** — do not alter existing or newly generated order numbers. It lives in `src/lib/order-number.ts` (`ORDER_NUMBER_PREFIX = "AP"`) and in the confirmation-cookie order-number validator. If the owner later wants a Gift Pacific prefix, the validator must accept **both** prefixes, new orders alone get the new prefix, existing rows are never rewritten, and courier references/search/invoices must be checked. That is a deliberate business change, not part of Phase 1.
<!-- branding-guard:allow-end -->

### 1.2 Branding guard

- `pnpm check:branding` → `scripts/check-branding.mjs` (no dependencies). Fails (exit 1) on old-brand text in any file outside `node_modules`, `.next`, `.git`, lockfile; checks **file/directory names**, **embedded metadata strings of binary assets** (pixels are not inspected), and **SHA-256 fingerprints of the two retired assets** (logo, favicon) anywhere in the tree, migrations included.
- Exempt: `prisma/migrations/**` (text and names); lines containing `branding-guard:allow` (or the line after it); blocks between `branding-guard:allow-start` and `branding-guard:allow-end`.
- Its patterns use character classes so the script and its test never match themselves. Tests: `tests/unit/branding-guard.test.ts` (also asserts the real repository is clean) and `tests/unit/consent-migration.test.ts`.
- Not caught by design: the abbreviation `AP` in order numbers (see above), image pixels, and text rendered inside images.
- **Run it in CI and before every release.** It is also part of `pnpm test` through the real-repository test.

---

## 2. Technology stack and architecture

- **Framework:** Next.js 16.3.3 (App Router, `src/proxy.ts` instead of `middleware.ts`), React 19.2.8, TypeScript 5.9 (strict). *Read `node_modules/next/dist/docs/` after install; this Next version differs from older ones.*
- **Data:** PostgreSQL + Prisma **6.19.3** (deliberately not v7), 60 models, 38 enums.
- **UI:** Tailwind CSS v4, hand-built shadcn-style kit on Radix, lucide-react, sonner, recharts, embla carousel.
- **Forms/validation:** React Hook Form + Zod 4.5.4. **Client state:** TanStack Query; Zustand only for cart-drawer open/close (cart data is server-side).
- **Auth:** custom — bcryptjs + JWT (`jose`, HS256) in httpOnly cookies. Not NextAuth.
- **Images:** Cloudinary (admin uploads). **Analytics:** GTM/GA4 + Meta Pixel (+ optional Meta Conversions API server events), TikTok/LinkedIn snippets (unverified).
- **Package manager:** pnpm 11.24.0 (`pnpm-workspace.yaml` allows build scripts only for prisma/esbuild; `minimumReleaseAgeExclude` pins `react-hook-form@7.87.0`).
- **Architecture rule:** business rules live in `src/server/services/*` and pure `src/lib/*` rule files; server actions (`src/server/actions`) only authorise, validate and call services; UI is in `src/features/*` and `src/components/*`.
- **Hosting target:** Vercel-style serverless + managed PostgreSQL (in-process caches/rate-limit counters are per instance; see §22).

---

## 3. Directory structure

```
AGENTS.md / CLAUDE.md      AI working rules (CLAUDE.md just imports AGENTS.md)
HANDOFF_GIFTPACIFIC.md     this file (the project handoff)
MASTER_ROADMAP.md          authoritative Phase 0–11 roadmap with evidence-based statuses
RELEASE_AUDIT.md           emergency-release issue register, evidence, preserved real-database test harness
RELEASE_CHECKLIST.md       owner deployment steps, read-only migration check, smoke tests, rollback
package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.json, eslint.config.mjs, next.config.ts, postcss.config.mjs
.env.example               variable names + explanations, no values
prisma/  schema.prisma, seed.ts (admin-only seed), migrations/ (28, never edit applied ones)
public/  (only generic SVGs; no brand assets)
scripts/ check-branding.mjs, set-user-password.ts, password-rules.ts
src/app/            routes: (auth) (shop) account admin/(dashboard) admin/login api docs, sitemap/robots/manifest, globals.css
src/components/     ui/ layout/ seo/ shared/
src/config/site.ts  name, nav, currency (logoUrl is "")
src/features/       UI by area: about account admin auth career cart checkout contact coupons home orders products search wishlist
src/hooks/  src/types/  src/utils/
src/lib/            pure rules + adapters: accounting, advance-policy, fraud-check, inventory-rules, order-transitions, combo, money, seo*, rate-limit, env.ts, production-checks, auth/, cart/, cloudinary/, courier/, db/, oauth/, payments/, analytics/, validations/ …
src/server/services business logic (≈55 services); src/server/actions thin server actions
tests/  unit/ (46 files) services/ (40) integration/ (5, need TEST_DATABASE_URL) setup/ (stubs, in-memory fake DB) fixtures/
```

Routes (71 pages): storefront (`/`, `/shop/[[...category]]`, `/products/[slug]`, `/search`, `/cart`, `/checkout`, `/checkout/confirmation/[orderNumber]`, `/boxes`, `/boxes/[slug]`, `/build-your-own-combo`, `/campaign`, `/about`, `/about-us`, `/career`, `/career/[slug]`, `/contact`, `/shipping-returns`, `/terms`, `/privacy`), auth (`/login`, `/register`, `/forgot-password`, `/reset-password`), customer (`/account`, `/account/orders[/orderNumber][/invoice]`, `/account/wishlist`, `/account/reviews`, `/account/notifications`, `/account/settings`), admin (`/admin/login` + 38 dashboard pages: orders, products, categories, inventory, advance, accounts, accounts/payments, courier, courier/bulk, courier/cod, customers, coupons, banners, campaigns, boxes, attributes, channels, expenses, reports, reports/channels, reviews, questions, rewards, careers, team, contacts, abandoned-carts, integrations, settings, orders/external/new), `/docs` (demo-only roadmap page; redirected unless `NEXT_PUBLIC_APP_ENV=demo`). API routes: `/api/auth/oauth/[provider]/{start,callback}`, `/api/courier/{reconcile,webhook,webhook/[provider]}`, `/api/payments/bkash/{callback,ipn}`.

---

## 4. Setup and installation

Prerequisites: Node 22, pnpm 11.24.0, PostgreSQL (local or managed), network access to npm and `binaries.prisma.sh` (Prisma engines) and Google Fonts (build).

```bash
pnpm install --frozen-lockfile     # postinstall runs `prisma generate`
cp .env.example .env               # fill DATABASE_URL, AUTH_SECRET, NEXT_PUBLIC_APP_URL (+ SEED_ADMIN_*)
pnpm db:deploy                     # prisma migrate deploy (NOT db push: order_number_seq and several SQL objects live in migrations)
pnpm db:seed                       # creates ONE admin user only (needs SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)
pnpm dev                           # http://localhost:3000 ; admin at /admin/login
```

Verification commands: `pnpm check:branding`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm exec prisma validate`. Real-PostgreSQL tests run only when `TEST_DATABASE_URL` points to a disposable database (`tests/integration/*.postgres.test.ts`; 24 tests are skipped otherwise). Other scripts: `pnpm db:studio`, `pnpm db:migrate` (development only), `pnpm user:set-password <email>` (operator password reset; the new password is passed as `NEW_PASSWORD` in the command's environment, never stored).

**Seed rules (fail-closed):** `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are required on every database (blank = unset); password ≥ 12 chars with lower, upper, digit, not a known default, not containing the email name. Only the admin user is created; categories/products/settings are added from the admin panel. An existing user with that email is never modified or promoted. Secrets and `DATABASE_URL` are never printed. A tunnel that makes a production database look like `localhost` cannot be detected — never seed through one.

---

## 5. Environment variables (names and purpose; no values are stored in the repository)

`src/lib/env.ts` validates the core set at startup; the rest are read where used and checked on `/admin/integrations`. `.env.example` is the template (never commit `.env`).

| Group | Variables | Purpose |
|---|---|---|
| Core (required) | `DATABASE_URL`, `AUTH_SECRET` (long random, **≥ 32 characters required in production** — the code enforces only 16, the startup check logs *critical* below 32; app refuses to start without it), `NEXT_PUBLIC_APP_URL` (https in production; used for canonicals, sitemap, OAuth and payment/courier callbacks) | |
| App | `NEXT_PUBLIC_APP_ENV` (`demo` shows `/docs`), `NEXT_PUBLIC_CURRENCY`, `NEXT_PUBLIC_CURRENCY_SYMBOL` | |
| Uploads | `UPLOAD_PROVIDER` (**code default is `local`, which cannot work on a serverless host: set `cloudinary` explicitly in production**), `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | admin image uploads (see §22 for the folder limitation) |
| Seed | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | one-time admin creation |
| Cron | `CRON_SECRET` (blank disables `/api/courier/reconcile`), `COURIER_AUTO_BOOK` (keep `false`) | scheduled courier polling |
| Courier (legacy names) | `COURIER_PROVIDER` (`none`/`steadfast`), `COURIER_API_KEY`, `COURIER_API_SECRET`, `COURIER_API_BASE_URL`, `COURIER_WEBHOOK_SECRET`, `COURIER_TIMEOUT_MS`, `COURIER_TRACKING_URL_TEMPLATE` | apply to the provider in `COURIER_PROVIDER` |
| Courier (per provider; win over legacy) | `COURIER_DEFAULT_PROVIDER`, `STEADFAST_ENABLED`, `STEADFAST_API_KEY`, `STEADFAST_API_SECRET`, `STEADFAST_WEBHOOK_SECRET`, `STEADFAST_API_BASE_URL`, `STEADFAST_TIMEOUT_MS`, `STEADFAST_TRACKING_URL_TEMPLATE` | |
| bKash | `BKASH_ENABLED`, `BKASH_ENV`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, optional `BKASH_BASE_URL`, `BKASH_TIMEOUT_MS`, `BKASH_IPN_TOPIC_ARN`, `GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD` | advance payments (unverified, §14) |
| Fraud check | `FRAUD_CHECK_PROVIDER`, `FRAUD_CHECK_ENABLED`, `FRAUD_CHECK_TIMEOUT_MS`, `FRAUD_CHECK_CACHE_SECONDS`, `FRAUD_CHECK_MAX_CALLS_PER_MINUTE` (+ `FRAUD_CHECK_API_KEY` / `FRAUD_CHECK_API_BASE_URL`, **ignored** by the Steadfast provider, which reuses the `STEADFAST_*` credentials) | §17 |
| Social login | `GOOGLE_CLIENT_ID/SECRET`, `FACEBOOK_APP_ID/SECRET` (a provider is on only when both are set) | |
| Analytics | `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_META_PIXEL_ID`, `META_CONVERSIONS_API_TOKEN` | |
| Misc | `RATE_LIMIT_ENABLED` (default on) | |
| Reserved/unused | `STRIPE_*`, `SSLCOMMERZ_*` (only validated so old `.env` files load; neither gateway is integrated, SSLCommerz is out of scope) | |

Callback/webhook URLs to register externally: `<APP_URL>/api/payments/bkash/callback`, `/api/payments/bkash/ipn` (needs `BKASH_IPN_TOPIC_ARN`), `/api/courier/webhook` and `/api/courier/webhook/steadfast` (Bearer secret), `/api/auth/oauth/{google,facebook}/callback`.

---

## 6. Database schema overview and migrations

### 6.1 Schema (60 models, 38 enums — `prisma/schema.prisma`)

- **Identity/customers:** `User` (role `ADMIN|CUSTOMER`), `OAuthAccount`, `PasswordResetToken`, `Address`, `Wishlist(+Item)`, `RecentlyViewedProduct`, `Notification`, `CustomerReward`.
- **Catalogue:** `Category`, `Collection` (campaigns), `Tag`, `Product` (+`ProductImage`, `ProductVariant`, `ProductCustomizationField`, `ProductBundleItem`, `ProductCollection`, `ProductTag`), attributes (`AttributeGroup`, `Attribute`, `AttributeOption`, `ProductAttributeValue`, `ProductAttributeOption`), combos (`ComboSlot`, `ComboSlotOption`), `Box`, `SlugRedirect`, `Review` (+`ReviewModerationEvent`), `ProductQuestion`.
- **Commerce:** `Cart(+Item, CartItemSelection)`, `Order` (+`OrderItem`, `OrderItemComponent`, `OrderTrackingEvent`, `OrderCostLine`), `Payment`, `Coupon`, `GatewayTransaction`, `GatewayRefund`, `CourierCodEntry` (append-only), `StockAdjustment`, `ProcurementReceipt`.
- **Finance:** `SalesChannel`, `Expense`, `FinancialIncident`, `MarketplaceSettlement`.
- **Site/ops:** `StoreSettings` (singleton row id `singleton`), `Banner`, `ContactMessage`, `TeamMember`, `JobPost/JobQuestion/JobApplication/JobApplicationAnswer`, `AdminAuditEvent`, `RateLimitBucket`.
- **Key enums:** `OrderStatus` PENDING, CONFIRMED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED, CANCELLED, FAILED_DELIVERY, REFUND_REQUESTED, REFUNDED · `PaymentStatus` UNPAID, PENDING, PARTIALLY_PAID, PAID, FAILED, REFUNDED, PARTIALLY_REFUNDED · `PaymentMethod` COD, MARKETPLACE, STRIPE, SSLCOMMERZ, BKASH, NAGAD (only COD/MARKETPLACE and the wallet-claim flow are live; BKASH only through the advance flow) · `ProductType` STANDARD, VARIANT, PERSONALIZED, BUNDLE · `ProductKind` SINGLE, COMBO (must agree with `type = BUNDLE`, a DB CHECK).
- **Database-level guarantees (in migrations, not expressible in Prisma):** `order_number_seq` sequence; `CHECK (stock >= 0)` on products/variants; partial unique index `GatewayTransaction_one_open_per_order`; append-only trigger on `CourierCodEntry`; unique `Review(userId, productId)`; unique wallet transaction id on payments; a kind/type CHECK.
- Cloudinary public ids are stored on **six** models: `ProductImage.cloudinaryPublicId`, `Banner.cloudinaryPublicId`, `Category.imageCloudinaryPublicId`, `Box.imagePublicId`, `TeamMember.imageCloudinaryPublicId` and `StoreSettings.logoCloudinaryPublicId` / `faviconCloudinaryPublicId` (the matching URLs are stored beside them).

### 6.2 Migrations and safe deployment (28 migrations, `prisma/migrations/`)

Order is by folder name (all sort correctly). Rules: **never edit or rename an applied migration; add a new one.** Production deploy: back up → `pnpm db:deploy` (`prisma migrate deploy`) → `prisma generate` → typecheck. **Never run `prisma migrate dev` against production.** `migrate dev` will also report drift for the partial unique index and the trigger and try to drop them: use `migrate deploy` and keep them. Migrations 9–10 and 15–18 depend on enum-value-in-own-migration ordering. Migrations 24–28 have **never been applied to any database by anyone in this project's record** (owner reported 1–23 deployed; unconfirmed); rehearse them on a copy of production first (partial index, trigger, refund-lifecycle backfill that marks existing PENDING refunds "uncertain"). Deploy migration 27 and the matching code together and issue no refunds during the rollout.

| # | Folder | Purpose |
|---|---|---|
| 1 | 20261008000000_init | initial schema, enums, `order_number_seq` |
| 2 | 20261010000000_courier_reviews_campaigns_stock | courier booking columns, review moderation + unique index, campaign flags, `StockAdjustment` |
| 3 | 20261012000000_brand_color_defaults | default theme colours (no row modified) |
| 4 | 20261017000000_drift_fix_ratelimit_unitcost | StockAdjustment FK drift fix, `RateLimitBucket`, unit cost |
| 5 | 20261018000000_combos_attributes_team_social_reviews | combos, attributes, team, social links |
| 6 | 20261019000000_channels_costs_settings | sales channels, costs, settings |
| 7 | 20261101000000_seo_keywords | SEO keyword arrays |
| 8 | 20261102000000_boxes | gift boxes |
| 9 | 20261103000000_combo_slot_source | combo slot source/category filter |
| 10 | 20261104000000_box_managed_product | hidden managed product per box |
| 11 | 20261105000000_inventory_procurement | procurement model, non-negative stock |
| 12 | 20261106000000_delivery_reward | delivery reward |
| 13–14 | 20261107000000_advance_payment_trust, 20261107000001_advance_payment_columns | advance payments, trust, unique wallet txn id |
| 15–18 | 20261108000000_accounting_incidents_settlement, 20261109000000_settlement_partial_status, 20261109000001_marketplace_settlements, 20261110000000_incident_discard_effect | incidents, settlements (enum values in their own migrations) |
| 19–20 | 20261110000001_stock_integrity, 20261111000000_advance_hardening | stock-movement integrity, advance hardening |
| 21 | 20261112000000_seo_phase5 | SEO fields, `SlugRedirect` |
| 22 | 20261113000000_brand_default_aura_petals | store-name default (see below) | <!-- branding-guard:allow -->
| 23 | 20261114000000_customer_experience_phase6 | notifications, recently viewed, product Q&A |
| 24 | 20261115000000_courier_cod_reconciliation_phase7 | `CourierCodEntry` + append-only trigger |
| 25–28 | 20261116000000_gateway_transactions_phase71, 20261117000000_gateway_refund_accounting_phase711, 20261118000000_gateway_refund_lifecycle_phase713, 20261119000000_refund_attestation_phase714 | gateway transactions/refunds, lifecycle, attestation |

<!-- branding-guard:allow-start -->
#### Migration checksum consistency — investigation result and the exact database-side action
(The ready-to-run **read-only PowerShell/SQL comparison of every migration checksum** is in `RELEASE_CHECKLIST.md` §4; the repository checksums of all 28 migrations are listed there. Production comparison remains **BLOCKED until the owner runs it**.)

Finding (from the repository only; no database was reachable):

- `20261008000000_init` and `20261113000000_brand_default_aura_petals` are the **only two migrations whose text contains the new brand name**. A manual find-and-replace evidently rewrote their *contents*. In the latter, the statement that used to rename an old default row is now `UPDATE "StoreSettings" SET "storeName" = 'Gift Pacific' WHERE "storeName" = 'Gift Pacific';`, **a no-op**. The original `WHERE` value was the old brand's store name (the Phase 7.2 notes describe it as "renames only a row still equal to the old default").
- Prisma records a SHA-256 of each `migration.sql` in `_prisma_migrations.checksum` when applying it. If either file was applied **before** it was edited, the stored checksum no longer matches the file. Whether `prisma migrate deploy` tolerates this was **not verified**; `migrate status`/`migrate dev` report modified migrations. **Nothing was changed in migration history in Phase 1.**
- Checksums of the files **as they are now in the repository** (`sha256sum prisma/migrations/<dir>/migration.sql`):

```
3ef94f52882684aff775096c8059ecb035750fea404594a98745c755b4922485  20261008000000_init
c4fd8c86ee042ddfc9976a757b71cd1d9062a92f79da9478f5aef86ce618bd8f  20261113000000_brand_default_aura_petals
```
(all 28 can be listed with: `for d in prisma/migrations/*/; do sha256sum "$d/migration.sql"; done`)

**Required, non-destructive actions for each real database (owner/DBA; read-only until step 3):**
1. Take a backup/snapshot. Run `pnpm exec prisma migrate status` against that database (read-only).
2. Run: `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name IN ('20261008000000_init','20261113000000_brand_default_aura_petals');` and compare the `checksum` column with the two hashes above. **Equal → no action.**
3. **Different** → the file was edited after it was applied. Do **not** run `migrate reset`/`migrate dev` and do not `migrate resolve` blindly. Preferred fix: restore the original text of that file from the archive/backup that was actually deployed and confirm its hash equals the database value. Only if no original exists: after owner approval and inside a transaction on a backed-up database, `UPDATE "_prisma_migrations" SET checksum = '<hash above>' WHERE migration_name = '<that migration>';` — this records that the current text is accepted and **does not re-run any SQL**. Both migrations' *effects* (column default `'Gift Pacific'`) are already satisfied by `schema.prisma`, so the schema state is the same either way.
4. **Store-name data check (independent of checksums).** Because the rename statement is now a no-op, a database whose settings row still holds the old name will keep displaying it. Check: `SELECT "storeName" FROM "StoreSettings";`. If it shows the old name, change it in **Admin → Settings → Store name** (preferred), or with a guarded update `UPDATE "StoreSettings" SET "storeName" = 'Gift Pacific' WHERE "storeName" = '<exact old name>';`. A name an admin typed is never touched by this.
5. Fresh databases are unaffected (default `'Gift Pacific'` from `init`).
<!-- branding-guard:allow-end -->

Not verified: that any migration applies cleanly on real PostgreSQL in this snapshot; the `schema.prisma` ↔ migrations drift test (`tests/unit/repo-guards.test.ts`) passes but is a text-level check.

---

## 7. Authentication and authorization

- **Two completely separate cookies:** `session` (customers) and `admin_session` (admins), both httpOnly, SameSite=Lax, 30-day signed JWT (HS256, `AUTH_SECRET`). `src/proxy.ts` gates `/account/*` with the customer cookie and `/admin/*` (except `/admin/login`) with the admin cookie and requires `role === "ADMIN"`; an admin session never opens `/account` and vice versa. `/docs` is redirected unless `NEXT_PUBLIC_APP_ENV=demo`.
- Authorisation is **also enforced inside every server action/service** (the proxy is not the only layer). Roles: `ADMIN`, `CUSTOMER` only — **there is no granular admin permission model** (any admin can do everything, including approving refunds, except the optional second-admin attestation threshold, §15).
- Passwords: bcryptjs. Rate limiting: in-memory + `RateLimitBucket` DB table; `RATE_LIMIT_ENABLED=false` only for debugging.
- Social login (Google/Facebook): optional, never creates or links admins, never auto-links to an existing password account; connect/disconnect from Account → Settings (disconnect only if another sign-in method remains). **Never exercised against real provider credentials.** Facebook emails are treated as unverified.
- **No email provider** → forgot-password shows the reset link on screen in development only; in production the recovery path is the operator command `pnpm user:set-password <email>` (see §22), or a social-only customer adds a password in Settings.
- Guests: guest cart token cookie; guest order confirmation secret is an httpOnly cookie (never in a URL).
- Status: **Implemented in source; verified by tests** for password/seed/session/proxy rules, except `tests/unit/proxy.test.ts` (known failing loader issue, §20). **Not verified in a real browser.**

---

## 8. Existing customer and admin functionality

**Storefront (implemented in source; tested at service level; never browser-verified):** homepage (hero, featured categories/products, new arrivals, gift bundles, testimonials), shop with category/price/stock/attribute filters and sort, search (overlay + page), product page (gallery, variant picker, personalisation fields, bundle contents, frequently-bought-together, recently viewed, reviews, Q&A), cart (guest + signed-in, merges on login, drawer), checkout (address, COD, coupon, delivery reward opt-in, wallet claim for advance), order confirmation (no email — says so), `/boxes` and `/build-your-own-combo`, `/campaign` (+ optional banner/popup), About/Team, Careers (applications private to admins; link-only, no CV upload), Contact, Shipping & returns, Terms, Privacy (describe real behaviour; **not legal advice, owner must review**), 404/empty/error states, sitemap (chunked + index) and robots, JSON-LD, canonicals, slug redirects, SEO keywords.

**Customer account:** dashboard, orders (history, detail, tracking timeline, printable invoice, Buy Again), wishlist, address book, reviews (only for delivered items; one per product, moderated, editable), notifications, profile/password/connected accounts, delivery-reward balance.

**Admin (38 pages):** dashboard (revenue chart, counts, low stock, finance cards), orders (status per policy, courier booking/manual entry, notes, advance & trust panel, invoice), external/marketplace orders, products (tabbed editor, variants, personalisation, combo contents/slots, attributes, media, stock adjustments), categories, attributes, boxes, campaigns, banners, coupons, inventory + procurement, advance & trust, accounts + payment reconciliation, expenses, channels, reports (+CSV, channel report), courier (queue, bulk booking, COD reconciliation), reviews and Q&A moderation, rewards, customers, careers/team/contacts, abandoned carts, integrations status, settings (store, shipping, tax, analytics IDs, logo, SEO, consent mode).

---

## 9. Existing functionality — status summary

Everything below is **Implemented in source** and, where noted, **Verified by tests** (fake in-memory DB). **Nothing is verified in a real environment** (real PostgreSQL, browser, third-party APIs). Details by area follow in §10–§18; the full matrix is §23.

---

## 10. Product, attribute, specification and variant implementation (the Phase 2 starting point)

**Implemented in source (and unit/service-tested):**
- `Product.type`: `STANDARD`, `VARIANT`, `PERSONALIZED`, `BUNDLE`; `Product.kind`: `SINGLE` or `COMBO` (DB CHECK: `COMBO` ⇔ `BUNDLE`). Statuses via `ProductStatus`; badges via `ProductBadge`; SEO fields and keyword tags; slug redirects on slug change.
- **Variants** (`ProductVariant`): a **flat list** per product. Each variant has its own `name`, unique `sku`, `price`, `stock`, `image`, backorder policy and procurement counters, an `isDefault` flag, and an **`options` JSON blob** (free-form option labels). There are **no normalised option axes** (no "Size" / "Colour" entity shared across a product's variants), no variant-level attribute values, and no per-variant gallery. A `VARIANT` product uses **only** its variants' stock; one with no purchasable variant is out of stock everywhere.
- **Personalisation:** `ProductCustomizationField` (types: text, textarea, date, colour, dropdown); image-upload personalisation was removed from V1. Server validates submitted values; snapshot stored on the order line.
- **Attributes** (generic, product-level): `AttributeGroup` → `Attribute` (value types TEXT, NUMBER, BOOLEAN, SELECT, MULTI_SELECT; optional unit, min/max, required, `isFilterable`, `showOnProduct`) → `AttributeOption`; values in `ProductAttributeValue` / `ProductAttributeOption`. Managed in Admin → Attributes and the product editor; filterable attributes appear as shop filters (`attribute-filters.tsx`); displayed on the product page when `showOnProduct`.
- **"Specifications":** there is **no dedicated specification model**. What customers see as specifications are the product-level attributes above plus free-text description. A separate, structured specification system (and variant-specific specifications) is **Missing**.
- **Product editor:** one tab strip — Basic information · Pricing · Inventory · Type & category · Badges & advanced · SEO · Variants & attributes · Media. Form tabs share one form; failed save jumps to the first tab with an error; unsaved-changes guard; creating saves the minimum valid record first. The type-specific managers (variants / personalisation / combo contents / selection groups / attributes) and the gallery save themselves.
- **Not verified:** the editor in a real browser (the Back-button guard depends on Next router behaviour and is untested).
- **Known limitations/debt to address in Phase 2:** variant `options` is unstructured JSON (cannot filter/validate by axis); attributes cannot differ per variant; no bulk variant generation from option axes; no per-variant images beyond one `image` field; no variant-level SEO/availability messaging; `ProductType` conflates "has variants", "personalised" and "combo".

## 11. Combo, mini-combo, set-combo and box implementation

**Implemented in source; verified by service tests (`combo-*`, `box*`, external-orders suites); not verified in a browser or real DB.** There is **no separate "mini-combo" or "set-combo" type** in the schema or code: the only concepts are `Product.kind = COMBO` (customer-facing combos, fixed or customisable) and `Box`. Any "mini"/"set" naming is a business/merchandising convention to be modelled in Phase 2 if wanted.

- **Combos** (`ComboMode`, `ComboPricing`, `ComboStockPolicy`): *fixed* (contents set by admin) or *customisable* (customer picks items per **slot**; `ComboSlot` with min/max and per-product limits, options in `ComboSlotOption`). Pricing: fixed price or "sum of component prices". Stock policy: `OWN_STOCK` (combo has its own stock, like a pre-assembled box) or `COMPONENTS` (selected components are deducted). **The server re-validates every selection, rebuilds allowed choices on each request (max 500 per slot), prices from current prices, deducts component stock, and stores an immutable snapshot** (`CartItemSelection`, `OrderItemComponent`).
- **Slot source** (`ComboSlotSource`): *Products I pick* (manual list) · *Any active product* (optionally one category; the combo must use "sum of component prices" — enforced on save) · *Our boxes* (active, stock-able boxes; fixed-price combos add the box price, sum-of-prices combos use the box price).
- **Boxes** (`Box`, Admin → Boxes, public `/boxes`, `/boxes/<slug>`): name, slug, image, order, active flag, price, stock, backorder policy, SEO. Saving keeps a hidden **managed product** (`Product.isBoxProduct`) in sync in one transaction; that product is what carts, checkout, stock, cancellation, invoices and snapshots use. Managed products never appear in shop/search/sitemap/"any product" groups and are `noindex`. A box can be bought alone, mixed in a cart, or chosen inside a combo. Deactivating a box takes the product off sale; deleting archives it. Older boxes linked to an ordinary product keep that link.
- `/build-your-own-combo` renders the customisable-combo builder for every active customisable combo (search + "show more" paging; chosen items stay pinned).
- **Rules that must not break:** combo components and boxes use **strict stock** (never procurement/backorder; `allowBackorder` is forced false for components); a combo sold from its own stock follows its own product's policy; the server — never the browser — decides price.
- **Missing/partial:** no distinct mini/set combo types; no combo-level bundle discount rules beyond fixed/sum pricing; component-level backorders impossible by design.

## 12. Inventory and procurement implementation

**Implemented in source; verified by service tests on the fake DB; the PostgreSQL integration tests were never run.** (`src/lib/inventory-rules.ts`, `src/server/services/order-inventory.ts`, `procurement.service.ts`, `stock-adjustment.service.ts`, `incident.service.ts`, `inventory-reconcile.service.ts`.)

- **Stock = available-to-sell.** An order placement subtracts stock in one atomic statement (`UPDATE … SET stock = stock - n WHERE stock >= n`); stock can never go negative (DB `CHECK (stock >= 0)` on products and variants). Per-product policy: *tracked* (default; out-of-stock blocked) · *untracked* (made-to-order, never counted) · *procurement/backorder* (units beyond stock are **not** subtracted; they are counted in `procurementPending`, optionally capped by "max units waiting to be sourced" — a capped order is refused whole).
- **Complete list of stock writers** (nothing else writes `stock`): checkout/external order (−), cancel before dispatch (+, claim-guarded, exactly the units still out), return judged *sellable* (+, via incident RESTOCK), return judged *unsellable* (0, DISCARD), shelf write-off (−, never on an order line), supplier receipt (+ surplus only), manual adjustment (±), legacy backorder link (0). Courier webhooks change order status only.
- **Per-line accounting:** `out = stockDeducted + procurementReceivedQty`; `returned`, `discarded`; `remaining = out − returned − discarded`; invariant `returned + discarded ≤ out` (DB CHECK). Every stock movement has a ledger row (`kind`, source, idempotency key); retries are no-ops.
- **Receiving goods** (Admin → Inventory → Receive): units first satisfy waiting orders oldest-first (they are *not* added to stock); only the surplus becomes sellable stock; each receipt is recorded (`ProcurementReceipt`). Orders with units still to source cannot be shipped/delivered or courier-booked.
- **After dispatch, cancel/refund does not restore stock automatically** (deliberate Phase 2 change): goods return to stock only when staff record a return as *sellable* or *unsellable* on the order line.
- **Legacy data:** migration 11 floored negative stock at 0 and moved the debt into `procurementPending` but left old order lines saying `stockDeducted = quantity`. Admin → Inventory shows a read-only "Stock data check" and an explicit *Apply* (re-runnable, refuses if data moved). It also flags possible historic double restocks and phantom stock: **these need a physical count; nothing auto-corrects them.**
- **Not built:** reservation expiry (unpaid PENDING orders hold stock until cancelled; no expiry job — needed before online payments with pending states), a separate "reserved" column, a customer-facing "ships after sourcing" message.
- **Known limits:** write-off of a unit reserved by an unshipped order is not modelled; incident refund cap is the order total, not money collected; real concurrency/row-lock behaviour is proven only by the unrun PostgreSQL tests.

## 13. Order lifecycle and stock handling

- **Statuses and allowed transitions** (`src/lib/order-transitions.ts`, one status funnel used by the admin action, the courier webhook and the reconcile job): `PENDING → CONFIRMED|CANCELLED` · `CONFIRMED → PROCESSING|CANCELLED` · `PROCESSING → SHIPPED|CANCELLED` · `SHIPPED → OUT_FOR_DELIVERY|DELIVERED|FAILED_DELIVERY` · `OUT_FOR_DELIVERY → DELIVERED|FAILED_DELIVERY` · `FAILED_DELIVERY → OUT_FOR_DELIVERY|CANCELLED` · `DELIVERED → REFUND_REQUESTED` · `REFUND_REQUESTED → REFUNDED` (approve) or back to `DELIVERED` (reject). `CANCELLED` and `REFUNDED` are terminal. Cancellation only before shipping. A failed delivery holds stock until cancelled.
- **Order numbers:** `AP-YYYYMM-NNNNNN` from PostgreSQL sequence `order_number_seq` (no collisions under concurrency). **Prefix kept unchanged by owner decision** (see §1.1).
- **Placement** (`order.service.ts` `placeOrder`): server recomputes prices/delivery/discounts/tax, checks stock atomically, applies coupon and optional delivery reward inside the transaction, runs the fraud-check/advance decision, freezes the trust snapshot, stores `shippingSnapshot`. Browser-supplied scores or amounts are ignored. Checkout accepts only COD (+ the wallet advance claim); a crafted request with another method is rejected and creates no order.
- **Dispatch gate:** an order cannot move into CONFIRMED/PROCESSING/SHIPPED/OUT_FOR_DELIVERY/DELIVERED, nor be courier-booked, while its required advance is unverified/unwaived or a required trust review is pending.
- **Customer visibility:** `order-visibility.ts` strips trust score/snapshot, waiver, settlement and stock/procurement fields from anything a customer receives (tested).
- **Delivery reward:** when an order becomes DELIVERED its signed-in customer earns one reward (discount on a later order's delivery charge; terms copied onto the reward; consumed inside the order transaction; withdrawn on refund if unused; given back on cancel/failed delivery if not expired). Off by default.
- Status: **Implemented; verified by service tests on the fake DB; not verified on PostgreSQL or in a browser.**

## 14. Payment and accounting implementation

**Payment methods in practice:** Cash on Delivery; **manual wallet advance** (customer enters wallet + transaction id = a *claim*; staff verify against the wallet statement); **bKash Tokenized Checkout for ADVANCE only** (implemented, unverified, off by default). Nagad, Stripe, SSLCommerz: **Missing / out of scope** (enum values exist only for compatibility).

- **Advance policy** (Admin → Advance & trust; `src/lib/advance-policy.ts`): **policy is OFF by default (`advanceEnabled = false`) — the owner must enable and confirm it in Admin → Advance & trust (verified on real PostgreSQL: with it off an outside-Dhaka order needs no advance; with it on, checkout without a payment claim is refused and the order cannot be confirmed until staff verify the advance)**; when on: zones in scope (default Outside Dhaka), standard ৳200 (configurable), reduced amount, thresholds 60/80/100, optional zero advance at full trust (default off), review rule (default on). The advance is part of the total (never an extra fee), capped at the order total, recomputed at placement and frozen on the order. A "Dhaka City" claim without Dhaka evidence is treated as Outside Dhaka for the advance decision and flagged for review.
- **Claims vs money:** a customer's transaction id is a `PENDING` payment with `customerReference` and no `providerRef`; only staff verification makes money (`PAID`, `providerRef`, verifier/time). `(method, providerRef)` is unique — one transaction can be credited to only one order. Verified advances may not exceed the order total.
- **Payment status is derived, not typed** (`derivePayment`): `paid = Σ verified payments`, `balance = total − paid`; UNPAID/PARTIALLY_PAID/PAID (a partial advance is never PAID), PARTIALLY_REFUNDED/REFUNDED once refunds are recorded. The admin dropdown is read-only. On DELIVERED a non-marketplace COD balance is recorded once as an explicit `BALANCE` payment (same moment accounting counts it); `advancePaid` stays "advances only" so money is never counted twice.
- **bKash (Phase 7.1):** grant, create, execute, query, search, refund, refund-status, SNS notification check; ADVANCE purpose only; signed-in owner only (guests cannot pay online); local 30-minute attempt limit; callback `/api/payments/bkash/callback`, notification `/api/payments/bkash/ipn` (needs `BKASH_IPN_TOPIC_ARN`; a notification only triggers a server-side re-check). **The entire API contract was taken from third-party client documentation, never from bKash's portal, and never run against any bKash account.** Online BALANCE/FULL is **not built** on purpose: COD amount, `recordCodCollection`, expected-COD and accounting all use `total − verified advance`; an online balance would be double counted unless those four places are changed together behind one shared function. Provider payloads (`rawInitiate`, `rawVerify`, `rawResponse`) are stored as JSON and may contain wallet numbers — review/redact before enabling. Startup checks flag `BKASH_ENABLED=true` and `BKASH_ENV=production` as critical.
- **Accounting** (`src/lib/accounting.ts` via `accounting.service.ts`; one set of definitions shared by Admin → Accounts, dashboard cards, channel report, sales report and both CSV exports):
  - *Date basis:* the order's placed date (marketplace "placed" date for third-party orders); expenses by spent date, incidents by occurred date, procurement receipts by receipt date.
  - *Sales (accrual):* orders except Cancelled/Refunded/Failed delivery; net sales = items − discounts; delivery billed separately; tax pass-through, excluded.
  - *Profit* = net sales + delivery billed − COGS (immutable unit-cost snapshot per line) − order costs (commission, payment fee, courier, packaging, other; all incurred lines even on failed orders) − damage/write-off losses − return/extra courier fees − refund compensation on orders that still count as sales − operating expenses. Unknown unit costs are never treated as zero: the report says **Estimated profit** and counts the lines without cost. Procurement purchases are cash only and never reduce profit.
  - *Cash:* verified advances + COD from delivered orders + marketplace payouts actually recorded as received, against refunds, expenses, our order costs, return fees, procurement purchases. A payment-status label is never cash; unverified customer-typed ids are shown separately.
  - *Outstanding:* customer balance (total − verified advance); marketplace receivable = expected payout − payouts received (partial payouts supported).
  - *Incidents* (damage, returns, failed deliveries, refunds, courier return fees, write-offs) carry explicit loss/refund/courier-fee amounts and an explicit stock effect; restocked goods are never a loss (DB check); refunds on an order cannot exceed what it billed.
  - *Limits:* period capped at 366 days and a fixed number of orders (the page says when totals would be incomplete); **no double-entry ledger**; courier remittance is not modelled.
  - Marketplace/third-party orders (Admin → Orders → External; channels, cost lines, settlements as append-only payouts) are implemented; tested in `third-party-finance`, `accounting-incidents`.
- Status: **Implemented; verified by service tests (fake DB) except bKash which is unverified by design.** Not run against real data. Accounting numbers have never been reconciled against a real month of orders.

## 15. Refund and reconciliation implementation

- **Customer refund request:** `requestRefund` moves a DELIVERED order to `REFUND_REQUESTED`; admin approves (→ `REFUNDED`) or rejects (→ back to `DELIVERED`). Stock is **not** auto-restored after dispatch (see §12).
- **Gateway (bKash) refunds** (`GatewayRefund`, `gateway-payment.service.ts`): implemented through an idempotency key; total refunds never exceed the payment; **lifecycle** distinguishes *never sent* (safe to resend) from *uncertain* (may have been sent; never auto-resent); an `uncertain` refund is resolved by **evidence + optional second-admin attestation** (admin records what the bKash dashboard shows, with a reference ≥ 10 minutes after the attempt; with `GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD` set, amounts at or above it need a different admin to approve; with a single admin account and the threshold set, above-threshold decisions cannot complete). A refund wrongly attested "No refund was made" **cannot be undone automatically**. Gateway refunds post to accounting through the existing REFUND financial record (keyed by refund id); a refund entered by hand first blocks auto-recording until an admin confirms. Recovery/bulk actions run sequentially with a 45 s budget, no queue/cron.
- **Migration 27 marks every existing PENDING refund "uncertain"** (never resent): keep refund processing paused during rollout until each is reconciled.
- **COD reconciliation** (Admin → Courier → COD; `CourierCodEntry`, **append-only** by DB trigger, which blocks UPDATE/DELETE but not TRUNCATE): expected COD = total − verified advance, recorded collections/remittances, flags for mismatches. **Payment reconciliation view** at Admin → Accounts → Payments.
- **Service authorisation:** every write service re-checks an active ADMIN (`assertAdminActor`) or one of exactly two internal system actors (`courier-sync`, `courier-reconcile`); a system actor must never be built from request data.
- Status: **Implemented; tested for our rules only** (`gateway-refund`, `courier-cod`, `service-authorization` suites pass on the fake DB). **No tests for bKash initiate/execute/IPN/amount-currency-invoice matching or settlement-ledger consistency.** Nothing run against bKash or real PostgreSQL.

## 16. Courier integrations and provider status

| Provider | Status |
|---|---|
| **Steadfast** | **Implemented in source, tested with mocks only; unverified against the live API and against Steadfast's official documentation.** Adapter `src/lib/courier/steadfast.ts` (create order with `Api-Key`/`Secret-Key`, status by consignment id, Bearer-token webhook); written from recollection of the public merchant API. Needs one authorised test parcel. |
| Pathao | **Missing, deliberately.** No official documentation/credentials. Only an `adapterAvailable: false` entry in `src/lib/courier/registry.ts`; cannot be selected or booked. |
| RedX | **Missing, deliberately.** Same. |
| Nagad / SSLCommerz | Missing / SSLCommerz out of scope. |

- **Booking:** a delivery operation only — never changes order status or stock itself. Eligible: COD orders in Confirmed/Processing with recipient name, valid BD mobile and address. COD amount = total − verified advance (0 if already paid). Sent: reference (order number), recipient, COD, short item description, customer note. Stored: courier name, consignment id, tracking code/URL, booking status, last courier status, sanitised last error (admin only). Raw provider payloads are not stored. **Idempotent** (a conditional DB update claims the booking before the network call). HTTP 4xx → `FAILED` (safe to retry); timeout/5xx/unreadable → `UNCERTAIN` (retry blocked until an admin confirms the courier portal was checked); "in progress" 10+ minutes → `UNCERTAIN`. Never auto-retried. Cancelling an order does **not** cancel the consignment (no confirmed cancellation call exists; cancel in the courier portal).
- **Status updates:** webhook `POST /api/courier/webhook` (and `/webhook/<provider>`) with `Authorization: Bearer <secret>` (constant-time check; 404 if not configured; 401 if wrong; body ≤ 64 KB; replays idempotent); manual "Refresh courier status"; scheduled `GET|POST /api/courier/reconcile` with `Authorization: Bearer $CRON_SECRET` (disabled when blank). Mapping (Steadfast): pending/in_review/hold → recorded only; `delivered*` → Delivered; `cancelled*` → Failed delivery (only if Shipped/Out for delivery); moves applied one legal step at a time through the normal policy; unknown statuses recorded and ignored. `COURIER_AUTO_BOOK=true` lets the reconcile job book CONFIRMED never-booked orders — **keep `false`** until a real booking succeeded. Bulk booking: Admin → Courier → Bulk (single-order path, 45 s budget, report on screen only).
- **Manual fallback:** "Manual courier entry" (courier, tracking number/URL) always works; an order then shows "Entered manually" and cannot also be API-booked.
- The checkout phone is normalised to `01XXXXXXXXX`; existing orders keep their stored format; Steadfast-style APIs expecting 11 digits is **unverified**.

---

## 17. Steadfast fraud-check implementation and known limitations

**Implemented in source; tested against third-party response examples and test-only `fetch` replacements; NOT verified against the live Steadfast API or its official documentation. Off unless `FRAUD_CHECK_PROVIDER=steadfast`.**

- **What it is:** a rule-based **trust score (0–100)** that decides the advance amount and whether staff must review. It is a heuristic, not a probability and not a fraud verdict. Its only evidence is a courier-network parcel record for the order's phone. **Website order history is not used** anywhere.
- **Formula** (`computeTrust`, `src/lib/advance-policy.ts`), clamped 0–100: verified phone `50 + 10×min(delivered,5) − 20×cancelled`; **unverified phone (every phone today): `50 − 20×cancelled`** — delivered history earns nothing because there is **no phone verification (OTP)**; `isPhoneVerified()` returns `false` and must not be changed to trust a profile phone. `returned` is displayed to admins, never scored. Tiers: `<60` low (standard advance **and** staff review) · `60–79` standard · `80–99` reduced · `100` full (reduced advance; zero only if "no advance at full trust" is enabled).
- **Adapter** (`src/server/services/fraud-providers/steadfast.ts`): `GET {STEADFAST_API_BASE_URL}/fraud_check/score/{01XXXXXXXXX}` (default base `https://portal.packzy.com/api/v1`), headers `Api-Key`/`Secret-Key`, reusing the courier credentials (no separate fraud credentials; `FRAUD_CHECK_API_KEY` / `FRAUD_CHECK_API_BASE_URL` are ignored by it); https only; `STEADFAST_ENABLED=false` switches it off. Maps **only** exact integer `delivered_count`/`cancelled_count`; percentages/bands/ranges are never turned into counts (no counts → `no_counts` → fallback). Non-200 body status, echoed different phone, non-integer counts, non-JSON → failure; HTTP 401/403 → `auth_failed`, 429 → `rate_limited`, other non-200 → `error`, timeout → `timeout`.
- **Pipeline** (`src/server/services/fraud-check.service.ts`): provider registry `{ steadfast }` (prototype-safe), TTL cache (default 600 s, max 86,400, 0 = off), failures remembered ≤ 30 s, concurrent lookups share one call, per-minute budget (default 60) over which checkout falls back, timeout default 3000 ms (500–10,000). Cache and budget are **per process** (per serverless instance).
- **States** stored in `order.trustSnapshot.fraudCheck` (counts only; `phoneLast4`, no phone number): `ok` · `no_history` · `unavailable` (reasons `no_provider`, `disabled`, `invalid_phone`, `timeout`, `error`, `invalid_response`, `rate_limited`, `auth_failed`, `no_counts`); `source` = `provider` or `fallback`. Every fallback gives score 50, standard advance, staff review; **never blocks checkout, never raises trust.** With nothing configured every customer scores 50.
- **Where it runs:** only on the server at `placeOrder` (`quoteAdvance` → `lookupFraudCheck`). The checkout price preview never calls the provider. Browser-sent scores/stats are ignored.
- **Admin:** Admin → Order → *Advance & trust* (phone checked, score, tier, real-vs-fallback, counts, time, warning if the order phone changed) and Admin → Advance (provider status, timeout, cache, budget, whether a credential is set — never the value). **Manual recheck** (ADMIN, checked in action and service): bypasses cache, stores `trustSnapshot.recheck` (last 5), audits `FRAUD_RECHECK` without the phone, 20/admin/hour and 1/order/minute; it changes nothing else.
- **Checkout phone rule:** contact phone and delivery phone must be Bangladesh mobiles (`01XXXXXXXXX`, `+8801…`, `8801…`, `008801…`; operator prefix 013–019), normalised to `01XXXXXXXXX` on the server and in the form (`bdPhoneSchema`). A signed-in customer whose saved phone is non-BD is asked to correct it.
- **Customers never see** any trust/fraud data (`order-visibility`, tested).
- **Known limitations / open items:** (1) official response schema (field names/types/nullability, not-found and error bodies) not checked; (2) what "delivered"/"cancelled" cover is unknown; (3) endpoint rate limits unknown; (4) if the official response has only ratios/bands every lookup is `no_counts` → standard advance for all (a ratio-based rule would be a business decision + new tested rule); (5) fixtures are third-party, not a redacted live response. `tests/fixtures/steadfast-fraud-check/counts-and-ratios.json` reproduces an example quoted in a public GitHub pull request (ashique19/Sun2 #346: `delivered_count`, `cancelled_count`, `volume_range`); `ratios-only.json` reproduces the README example of an unofficial SDK (Sifat07/steadfast-merchant-sdk: percentages, a volume band, no counts). The two sources disagree on whether counts exist, which is why the adapter maps only exact integer counts. **They are not the official guide**: replace them with examples from the official guide and re-run `tests/unit/steadfast-fraud-provider.test.ts`; (6) written permission for merchant lookups of customer phones and final privacy wording (the privacy page says the lookup is conditional); (7) no OTP/verified phone.
- **Before enabling (read-only, uses your real quota):** `curl -s -H "Api-Key: $STEADFAST_API_KEY" -H "Secret-Key: $STEADFAST_API_SECRET" "https://portal.packzy.com/api/v1/fraud_check/score/01XXXXXXXXX"` with a number you own; compare with the official guide; enable on a demo/rehearsal copy first and use "Recheck fraud result now". **If the endpoint exists only in Steadfast's web panel it must not be integrated (no portal scraping).**
- **Adding another provider:** implement `FraudCheckProvider { key, check(phone, signal) }`, register in `PROVIDERS` and `KNOWN_FRAUD_PROVIDERS`, use only the provider's **official** status mapping, add fixtures from a real redacted response and tests; never invent a status mapping.

## 18. Marketing, campaign, coupon, SEO and analytics functionality

**Implemented in source; service/unit-tested where noted; none verified in a browser or against real analytics accounts.**

- **Coupons** (`CouponType`: PERCENTAGE, FIXED; Admin → Coupons): validated and applied server-side at checkout; may combine with delivery reward only if the reward terms allow. (A "free delivery coupon" appears on the old V1.1 roadmap and is **Missing**.)
- **Campaigns** (Admin → Campaigns; `Collection` campaign flags): name, slug, image/description, active flag, optional start/end (end inclusive in Bangladesh time), product assignment. `/campaign` lists the active campaign's ACTIVE products (empty-state + `noindex` when none runs; in the sitemap only while one runs). Banner placement *Campaign banner* = single image linking to `/campaign`; placement *Popup* shows once per browser session (never on checkout/account pages); banner start/end dates schedule seasonal banners. Placements: Hero, Promo Strip, Mid-page, Campaign, Popup. **Known failing test** `campaigns` (stale expected key list, §20).
- **Delivery reward** (repeat purchase): §13. **Abandoned cart list:** Admin → Abandoned carts. **Notifications:** in-app only (no email/SMS).
- **SEO** (`src/lib/seo*.ts`, `structured-data.ts`, `sitemap.service.ts`): central title template and metadata (store name comes from settings, with `siteConfig.name` fallback), Open Graph/Twitter metadata, canonical URLs, JSON-LD (Organization, WebSite + SearchAction, BreadcrumbList, Product with Offer/AggregateOffer), chunked sitemap + index (`generateSitemaps`), robots, slug-change redirects (`SlugRedirect`), image alt/SEO fields, SEO keywords on products/boxes/settings (optional), `noindex` for empty campaign, box-managed products, and unavailable states. Open Graph/Twitter images are emitted only when a page/product has an image set (`src/lib/seo.ts`); a logo-based default share image was **not verified** and none is shipped. A **minimal web manifest** now exists (`src/app/manifest.ts` → `/manifest.webmanifest`: `name`/`short_name` `Gift Pacific`, `start_url` `/`, `lang` `en`, `display` `browser`; **no icons, no theme/background colour, no service worker, no offline caching**; static, no database). Without icons it is not installable: **OWNER ASSET REQUIRED** (official icons) before any install/PWA work. Verified by unit test and an HTTP 200 `application/manifest+json` on the Next dev server; not verified in a production build or a browser. A **favicon is missing** until supplied (§1.1). Note: `src/app/sitemap.ts` queries the database at build time (`generateSitemaps` → product count), so `pnpm build` needs a reachable database.
- **Analytics** (`src/lib/analytics/`): one event abstraction forwarding PageView, ViewContent, Search, AddToCart, AddToWishlist, InitiateCheckout, AddPaymentInfo, Purchase to GTM/GA4 and Meta Pixel (IDs validated against real formats), optional TikTok and LinkedIn snippets (**unverified against real accounts**, off unless an ID is set). Consent mode (`ConsentMode`: `OFF` | `OPT_IN`): with `OPT_IN` nothing loads before the visitor accepts; the choice is stored under `giftpacific_consent_v1` (legacy key still honoured, §1.1). Analytics never loads on admin, account, login/register or password-reset pages. Page views send the path only (no query string, hash or order number). Purchase fires once per order (localStorage guard) with only order number, value and currency; the optional server-side Purchase (Meta Conversions API, `META_CONVERSIONS_API_TOKEN`) uses the same event id so Meta de-duplicates.
- **Design system (storefront):** Gift Pacific design restored in 7.4.2 — olive primary `#3a3f2b`, dark footer, `container mx-auto` layouts, Cormorant headings + Manrope body, Noto Serif Bengali as the Bengali fallback (stack in `src/app/layout.tsx` and `globals.css`; owner decision: do not restore Cormorant Garamond or Hind Siliguri); tokens in `src/app/globals.css`. Fonts are fetched from Google Fonts at build time through `next/font/google` (the build fails offline; self-host with `next/font/local` if a build must work without internet).
- **Roadmap page:** `/docs` renders `src/config/roadmap.ts` (visible only with `NEXT_PUBLIC_APP_ENV=demo`). It is a stale V1.0/V1.1/V2 list; the Markdown copy was removed in Phase 1. Update or delete `roadmap.ts` deliberately.

## 19. Tests and verification status

### 19.1 Phase 1 verification (executed during Phase 1; Node 22.23, pnpm 11.24.0, deps from the frozen lockfile)

| Check | Result |
|---|---|
| Old-brand search (final, see §19.3) | executed; remaining matches explained |
| `pnpm check:branding` | **PASS** ("no unintended old-brand references"), also from a freshly extracted copy of the final ZIP |
| `pnpm install --frozen-lockfile --ignore-scripts` | PASS |
| `pnpm exec prisma validate` | PASS |
| `prisma generate` | Types generated **with placeholder engine binaries** (`PRISMA_SCHEMA_ENGINE_BINARY` / `PRISMA_QUERY_ENGINE_LIBRARY` pointed at an empty file) because `binaries.prisma.sh` was unreachable. Good enough for typechecking; **not** a real engine, no DB queries possible. |
| `pnpm typecheck` | **PASS** (exit 0, 0 errors). First full typecheck since Phase 3. |
| `pnpm lint` | **FAIL, pre-existing:** 22 errors + 10 warnings in 14 files — identical set and counts on the untouched original archive (none caused by Phase 1). See §20. |
| `pnpm test` | 792 tests: 764 pass, **4 fail**, 24 skipped (real-PostgreSQL tests: no database). The same 4 fail on the untouched original (779 tests / 751 pass / 4 fail / 24 skipped there; Phase 1 added 13 passing tests). See §20. |
| `pnpm build` | **FAIL — environment:** all 4 errors are `next/font` failing to fetch the fonts of that time (historical set; the current set is Cormorant, Manrope, Noto Serif Bengali) from `fonts.googleapis.com` (no outbound access in the verification environment). Nothing else was reached. **Build not verified.** Also expected to need a database for sitemap generation (P-3 below). |
| Migration consistency | Static inspection only: 28 migration folders; checksums of the two edited ones recorded in §6.2; schema↔migration drift text test passes inside `pnpm test`. **No database was available** — `migrate status`/`diff`/`deploy` NOT RUN. |

### 19.1b Emergency-release verification (executed after Phase 1; evidence in `RELEASE_AUDIT.md`)

| Check | Result | What it establishes — and what it does not |
|---|---|---|
| PostgreSQL 16 (apt) + all 28 migrations applied in order to an **empty** database | PASS | The migration SQL is valid and complete on a fresh database (60 tables, 38 enums, `order_number_seq`, append-only trigger, partial unique index). **Not** production migration status. |
| Prisma data model ↔ migrated database comparison (tables, columns, nullability, base types, enums) | no differences (only the *order* of values in `PaymentStatus`/`PaymentMethod` differs; sets equal) | Schema/migration consistency on a fresh database. `prisma migrate diff` could not run (engine download blocked). |
| 24 real-PostgreSQL integration tests (`TEST_DATABASE_URL`, `pg` installed outside the project) | 24/24 PASS | Row-lock/concurrency/constraint behaviour proven on a real database for the first time. |
| 12 real-database release scenarios (real service code, engine-free Prisma client + `pg` adapter; harness preserved in `RELEASE_AUDIT.md` Appendix A) | 12/12 PASS | Order integrity, oversell race, duplicate submit, cancel/restore once, advance gate, one-transaction-one-order, authorization, ownership **at service level on real PostgreSQL**. Not HTTP/browser. |
| `pnpm build` in the real environment | **FAILS** — Google Fonts unreachable (4 `next/font` errors) | Environment, not a code error. **Genuine production build: NOT VERIFIED.** |
| Webpack build of a clean lockfile-based copy with **mocked font CSS** | exit 0, all routes generated | Compilation, typecheck and route generation succeed with the application code. **Supplementary only** — not a genuine build (fonts mocked, Prisma engine-free client, webpack instead of the default Turbopack). |
| HTTP smoke on that build against the rehearsal database | `/`, `/shop`, category, product, variant product, search, `/cart`, `/checkout`, `/login`, info pages, `/boxes`, `/campaign` = 200; `/account` 307→login; `/admin*` 307→admin login; `/docs` 307→`/`; courier reconcile 401, webhook/IPN GET 405 | Real responses; no server errors logged. **No browser, no client-side interaction, no POST flows over HTTP.** |
| Security headers on real responses (200, 307, 401) | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` present | Headers only; no CSP by decision. |
| Public-data leakage check | no cost price or hash in home/shop/product/search/cart/checkout HTML; DRAFT product answers "not found" and is absent from the sitemap | |
| Read-only migration check script (PowerShell 7.5.4) against an **emulated** `_prisma_migrations` table | reported 26 MATCH, 1 MISMATCH, 1 NOT FINISHED as constructed | The script logic and output parsing work. **Windows PowerShell 5.1 not tested; production not checked.** |
| Final source checks | branding guard OK · `prisma validate` OK · typecheck 0 errors · lint 22 errors/10 warnings (identical file set to the original archive) · tests 795 run: 767 pass, 4 fail (same pre-existing), 24 skipped when no database is configured | |

### 19.1c Phase 1 completion pass (executed; Node 22.23, pnpm 11.24.0, frozen lockfile, `--ignore-scripts`)

| Check | Result | Notes |
|---|---|---|
| `pnpm check:branding` | **PASS** | Before and after the changes. |
| `pnpm exec prisma validate` | **PASS** | Run with placeholder engine env vars (`PRISMA_SCHEMA_ENGINE_BINARY` etc.) because `binaries.prisma.sh` is unreachable; schema validation only. `prisma generate` likewise produced types with a placeholder engine, not a real one. |
| `pnpm typecheck` | **PASS** (exit 0) | Before and after. |
| `pnpm test` | 799 run: **771 pass, 4 fail, 24 skipped** | Baseline was 795/767/4/24; the +4 are the new `tests/unit/brand-assets.test.ts`. The 4 failures are the identical pre-existing set (stale campaigns test, hero pause a11y, `proxy.test.ts`, theme-vs-migration guard). The new loading-screen/asset guards were shown to **fail on the original `loading.tsx`** and pass with the fix. |
| `pnpm lint` | **FAIL, pre-existing**: 34 problems (22 errors, 12 warnings) | Identical to the untouched ZIP (same files); none in files changed in Phase 1. (Earlier docs said 10 warnings; the real count is 12.) |
| `/manifest.webmanifest` on `next dev` (Turbopack, port 3100) | HTTP 200, `application/manifest+json`, body as designed, security headers applied | Dev server only; no database or fonts involved for this route. |
| Owner SQL (storeName; Cloudinary folders across all six models) | Executed against a **scratch PostgreSQL 16** with all 28 migrations applied; read-only session refused a write | Proves syntax and column names only. **Never run against production.** |
| Repository migration checksums | all 28 equal `RELEASE_CHECKLIST.md` §4.4; migrations byte-identical to the ZIP | Production comparison remains **BLOCKED** (owner). |
| `pnpm build` | **NOT RUN** | Needs Google Fonts (`next/font/google`) and a reachable database; neither is available here. Fonts were not mocked. |

### 19.2 What the suite is

- `pnpm test` = Node's built-in runner via `tsx` over `tests/unit/*.test.ts` (45 files), `tests/services/*.test.ts` (40) and `tests/integration/*.test.ts` (5). Runner: `node --import tsx --import ./tests/setup/register.mjs --test <files>`. `tests/setup/` has stubs for `next/headers`, Prisma, auth, cloudinary and an **in-memory database double** (`fake-db.ts`): advisory locks are no-ops and transactions run one at a time, so **real concurrency/locking is not proven**. If a new service test fails because the double lacks an operator, fix the double, not the assertion. Tests are excluded from `tsc` but linted.
- Integration tests (`*.postgres.test.ts`) need `TEST_DATABASE_URL` pointing at a **disposable** database. They `import("pg")`, which is **not a dependency** (finding P-2): with a URL set they fail to load; use a throw-away copy of the project with `pnpm add -D pg`. Never point them at demo/live data.
- There is **no browser test framework**; browser checks are manual.
- Phase-3 baseline was 601 tests; the suite has since grown (Phase 1 final: 792).

## 20. Known bugs, technical debt and unverified behaviour

**Found and FIXED in the emergency release:** the home page returned HTTP 500 whenever no *Campaign*-placement banner was active (a fresh store, a deleted banner, or a banner whose end date passed) because `src/app/(shop)/page.tsx` read `campaignBanner.imageUrl` unguarded (TypeScript could not catch it). Fixed with `campaignBanner?.imageUrl ?? null`; regression guard `tests/unit/homepage-empty-state.test.ts`; verified by a successful build/prerender and HTTP 200 with and without banners.

**Open findings from the emergency HTTP smoke (P1, see `MASTER_ROADMAP.md` deferrals):** `robots.txt` advertises `/sitemap.xml`, which answers 404 (the sitemap is served at `/sitemap/0.xml`; submit that URL to Search Console); unknown or draft product URLs answer HTTP 200 with a "not found" page marked `noindex` (soft 404, caused by the root `loading.tsx` streaming); no Content-Security-Policy; `pnpm build` needs a reachable database (sitemap) and Google Fonts access.

**Required reference data:** migration 6 inserts the `channel_website` row in `SalesChannel`. Every website order points at it; if it is missing every checkout fails with a foreign-key error. Never truncate or reseed that table.

**Known failing checks (all pre-existing, none caused by Phase 1 or the emergency release; nothing was weakened or skipped):**
1. `tests/unit/proxy.test.ts` — the file uses top-level `await` and the `tsx`/esbuild CJS loader rejects it ("Top-level await is currently not supported with the cjs output format"), so the proxy/route-gating tests **never run**. Fix the test file's module format; until then proxy gating is unverified by tests.
2. `tests/unit/repo-guards.test.ts` "accessibility basics" — expects a hero carousel control labelled "Pause automatic slide rotation" that does not exist (**a real accessibility gap**, WCAG 2.2.2).
3. `tests/unit/theme.test.ts` "brand colors … migrations agree" — fails because the test forbids any `UPDATE "StoreSettings"` in migrations and migration 22 contains one (the store-name rename, now a no-op). It cannot be fixed by editing the applied migration; relax the guard to allow that one migration, deliberately.
4. `tests/services/campaigns.test.ts` "only an active campaign inside its window is shown" — stale expected key list (the code now also returns SEO fields).
5. **ESLint: 22 errors, 10 warnings**, in `src/app/(shop)/page.tsx`, `src/app/(shop)/products/[slug]/page.tsx`, `src/components/layout/sticky-header.tsx`, `src/components/shared/reveal.tsx`, `src/features/admin/category-form-dialog.tsx` (196:22), `src/features/admin/incident-form.tsx` (21:26), `src/features/search/search-overlay.tsx`, `src/server/actions/admin-order.actions.ts`, `src/server/actions/admin-product.actions.ts`, and tests `advance-hardening`, `courier-cod`, `order-number`, `third-party-finance`, `tests/setup/fake-db.ts` (many are React-hooks rules such as set-state-in-effect and unused/unnecessary `eslint-disable` directives). Run `pnpm lint` for the list.

**Debt and risks:**
- **No real-environment verification of anything**: PostgreSQL, browser, Steadfast, bKash, Cloudinary, OAuth, analytics. See §23.
- **Migrations:** possible checksum drift on migrations 1 and 22 and a no-op store-name rename (§6.2); migrations 24–28 never applied/rehearsed anywhere on record.
- **Build:** needs internet (Google Fonts) and a reachable database (sitemap count at build time).
- `package.json` defines `db:migrate` = `prisma migrate dev` — never against a real database.
- No email provider (no order confirmation/password reset email); no OTP/verified phone; no CV upload; no hosted error tracker/alerting/uptime monitoring; in-memory caches and rate-limit counters per instance.
- Cloudinary uploads abandoned by leaving the product-create page are not deleted (only removing an image in the editor deletes it).
- `CourierCodEntry` trigger blocks UPDATE/DELETE, not TRUNCATE; provider payload JSON may contain wallet numbers (redact before enabling bKash); read-only admin queries rely on page/action guards (no service-level check).
- Unpaid PENDING orders hold stock indefinitely (no expiry job).
- Facebook login emails treated unverified; TikTok/LinkedIn snippets unverified.
- `public/` still contains the five default create-next-app SVGs (generic framework assets, not branding).
- `.gitignore` ignores `.env*` but keeps `!.env.example`.
- **Cloudinary folder restriction** — see §22.
- **Additional risks recorded in earlier phases (still valid):**
  - Advance zone evidence is a keyword heuristic (`DHAKA_MARKERS` in `src/lib/advance-policy.ts`): a genuine Dhaka address naming none of the markers is treated as Outside Dhaka (asked for the advance and flagged for review). The delivery *charge* still follows the customer's chosen zone.
  - The checkout "advance required" preview is computed from the zone only; the server's figure always wins and is returned in the error.
  - Shop-caused cancellations still count as "cancelled" in a customer's score (the data cannot tell who cancelled).
  - Verifying an advance on an already-cancelled order is allowed (the money arrived); it then needs a refund incident.
  - COD is treated as collected when staff mark the order DELIVERED (no courier remittance tracking); a delivery later found uncollected needs a refund/incident record. Cash/COD is attributed to the order date (delivery/settlement dates are not stored).
  - Staff can no longer type a payment status; any admin can waive an advance (no four-eyes approval or waiver cap).
  - Supplier receipts allocate to waiting orders oldest-first; if two receipts race on one line the loser's units go to stock (safe; the waiting order needs another receipt). The migration-19 back-fill assumes the old release formula was applied to every released line; hand-edited lines are not detectable.
  - Marketplace: a REFUND incident on a marketplace order is cash out by us (marketplace-side refunds should be recorded as a smaller payout — documented, not enforced); payout rows cannot be edited/voided in the UI; there is no "write off shortfall" action (correct the commission line); the order page does not show payout history per order (it is on Accounts).
  - Theme colours: a store that deliberately chose exactly the old default colours `#829265` / `#f6f1ea` is indistinguishable from "not customised" and gets the new palette.
  - Out of scope and not built: payment gateways other than bKash-advance, POS/warehouse, marketing automation, a newsletter backend, a hosted error tracker.

## 21. Existing business rules that must not be broken

1. **COD is the only completed payment path; advance via claim → staff verification (or bKash, unverified).** A customer-typed transaction id is a claim, never money. One transaction id credits at most one order. Payment status is derived from verified payments; never editable by hand.
2. **Server decides everything financial:** prices, totals, delivery, discounts, advance, trust decision, combo price and allowed choices — never the browser.
3. **Stock never goes negative; stock is deducted once at placement (atomic guarded UPDATE) and restored exactly once** (cancel before dispatch). After dispatch, goods return only through a recorded sellable return. Backorder units are `procurementPending`, never negative stock. Orders with units still to source cannot be dispatched. Combo components and boxes use strict stock.
4. **Order statuses follow `order-transitions.ts` only,** through the single funnel; `CANCELLED`/`REFUNDED` are terminal; the dispatch gate (advance + review) cannot be bypassed; courier events can never cancel/refund.
5. **Courier booking is idempotent and never auto-retried;** `UNCERTAIN` needs an admin who checked the courier portal. Booking never changes order status/stock. `COURIER_AUTO_BOOK` stays `false` until a real booking succeeded.
6. **Gateway refunds are idempotent and never auto-resent when uncertain;** an uncertain refund needs evidence (+ second admin above the threshold). Total refunds never exceed the payment.
7. **Accounting uses one set of definitions** (`accounting.ts`); unknown costs are never zero; procurement purchases never reduce profit; COD = total − verified advance everywhere (four places must change together).
8. **Trust/fraud data and internal fields are never customer-visible** (`order-visibility`); no phone number or credential is logged or stored in snapshots; fraud checks run server-side only, fallback never blocks checkout or raises trust.
9. **Two separate sessions** (customer `session`, admin `admin_session`); admin-only actions re-check an active ADMIN inside the service; system actors are never built from request data.
10. **Migrations:** never edit/rename an applied one; only `migrate deploy` on real databases; keep the partial unique index and the append-only trigger.
11. **Reviews** only from delivered buyers, one per product, moderated; Careers applications private; no CV upload.
12. **Never invent integrations:** Pathao, RedX, Nagad stay unimplemented until official documentation and credentials exist; SSLCommerz is out of scope; never guess API fields or status mappings.
13. **Branding:** the active brand is Gift Pacific; never reintroduce the discontinued brand; `pnpm check:branding` must pass; the `AP-` order-number prefix is unchanged until the owner decides.
14. **Home/shop pages must tolerate empty data:** optional records (banners, campaigns, categories, reviews) may be absent; never dereference them unguarded.
15. **No secrets in the repository;** `.env.example` has names only.
16. **Public data goes through an allow-list DTO** (`src/lib/product-dto.ts`) plus explicit Prisma `select`s: `costPrice`, raw stock, `allowBackorder`, `trackInventory`, variant SKUs, bundle-component rows and internal ids must never reach a Client Component. Admin child resources (images, variants, personalisation fields, bundle items) are scoped to their parent product inside the service layer. Login forms must never be pre-filled with credentials; `?redirect=` targets must be validated; JSON-LD and analytics IDs must be escaped/validated; uploads are JPEG/PNG/WebP only with a magic-byte check and an 8 MB limit (matching the Server Action body limit in `next.config.ts`).

## 22. Deployment architecture and operational instructions

**Architecture (intended):** Next.js on a Node/serverless host (Vercel-style) → managed PostgreSQL (backups enabled) → Cloudinary for images → optional cron calling `/api/courier/reconcile` with `Authorization: Bearer $CRON_SECRET` (Vercel Hobby = daily only; otherwise GitHub Actions or system cron + curl). Webhooks inbound: courier webhook (Bearer secret), bKash callback/IPN. **No deployment has been verified from this snapshot.** Production env must have: `DATABASE_URL`, `AUTH_SECRET` (≥ 32 random chars), `NEXT_PUBLIC_APP_URL` (https, not localhost), Cloudinary trio; keep `COURIER_AUTO_BOOK=false`, `BKASH_ENABLED=false`, `FRAUD_CHECK_PROVIDER` unset until each integration is verified. On every start the app logs `config.critical` / `config.warning` lines (placeholder `AUTH_SECRET`, localhost public URL, courier without webhook secret, bKash on/production, auto-book on).

**The owner's step-by-step procedure (backup, read-only migration check, environment variables, smoke tests, rollback, manual fallbacks) is `RELEASE_CHECKLIST.md`.** Baseline security headers (nosniff, X-Frame-Options DENY, strict-origin-when-cross-origin) are set in `next.config.ts`; a CSP is intentionally not set. **Deploy procedure:** back up → `pnpm install --frozen-lockfile` → `pnpm db:deploy` → `prisma generate` → `pnpm typecheck` → `pnpm build` (needs internet for fonts and a DB for sitemap count) → start. Never `migrate dev`/`reset`/`db push`. Run the seed once with explicit admin credentials, then remove them.

### Cloudinary folder restriction (owner decision: keep for now)
- **Upload pipeline (large-image fix).** Admin images used to be read in the browser as a base64 data URL and passed as a Server Action argument; React's Server Action decoder counts every string argument's characters against a 1,000,000 budget, so any file above roughly 750 KB failed with "Maximum array nesting exceeded" (reproduced with React's own encoder/decoder). Now: `SingleImageUploader` / `GalleryImageUploader` → `uploadImageFile` (`src/lib/cloudinary/upload-image.ts`) → (1) Server Action `createUploadSignatureAction(folder, nameHint)` returns a tiny signed descriptor (API key + signature; the API secret never leaves `cloudinary.ts`), (2) the browser POSTs the `File` itself in `FormData` straight to Cloudinary (`browser-upload.ts`; single request up to 20 MiB, otherwise sequential 20 MiB chunks with `X-Unique-Upload-Id`/`Content-Range`, each chunk retried on network error/5xx). Folder, public id and `allowed_formats=jpg,png,webp` are signed, so the client cannot change them. The original is stored untouched; **there is no application-level size cap**. The only limits are Cloudinary's own plan limits (commonly cited: 10 MB Free / 20 MB Plus / 40 MB Advanced per image, plus megapixel limits; chunking does not lift them): Cloudinary's rejection message is shown to the admin verbatim. **Not verified against the real account** (no credentials/network in the build environment): confirm the plan's actual limit and do one real banner upload. Delivery: `images.loaderFile` (`src/lib/cloudinary/image-loader.ts`) rewrites Cloudinary URLs to `f_auto,q_auto,c_limit,w_<width>` appended after any existing transformation; all other images still use the built-in `/_next/image` optimizer. **Never set `images.loader: "custom"`** (it switches that optimizer off and 404s every non-Cloudinary image) and never put `"use client"` on the loader file (Server Components call it). If a Content-Security-Policy is added in Phase 10, `connect-src` must allow `https://api.cloudinary.com`, and `img-src` `https://res.cloudinary.com`. There is no crop/edit UI in the codebase; previews use CSS `object-cover`, and the only URL transformation elsewhere is `socialImageUrl` in `src/lib/seo.ts`.
- New uploads go to `giftpacific/<folder>` (`src/lib/cloudinary/cloudinary.ts`); `isAppCloudinaryPublicId` (`src/lib/upload-validation.ts`, `CLOUDINARY_FOLDER_PREFIX = "giftpacific/"`) makes `deleteCloudinaryImageAction` and `discardUnsavedUploadAction` accept **only** public ids starting with `giftpacific/`; anything else returns "Invalid image id." and is **not deleted**.
- **Limitation (corrected in the Phase 1 completion pass; read from source, never executed):** images uploaded by an earlier version of the store under a different top-level folder are still displayed (URLs are stored). The `giftpacific/` check covers **only** the two client-callable actions above. The server-side save/delete flows (product images, banners, logo/favicon replace, categories, team, boxes in `src/server/actions/*`) call `deleteImageFromCloudinary(<stored public id>)` **without any prefix check**, so a legacy-folder asset that an admin replaces or removes through those flows **is** destroyed on Cloudinary, while the guarded actions refuse it (inconsistent, not a display problem). No old folder name appears anywhere in the source, so the previous folder name cannot be determined from this repository. No asset was touched in Phase 1; cleanup/migration stays **OWNER ACTION REQUIRED**.
- **Verify the real production folders (read-only):**
  1. Database (read-only; run with `PGOPTIONS="-c default_transaction_read_only=on"`). Public ids exist on **six** models, so check all of them (statement validated against the migrated schema on a scratch PostgreSQL 16, never against production):
     ```sql
     SELECT 'ProductImage' AS source, split_part("cloudinaryPublicId", '/', 1) AS top_folder, count(*) AS n FROM "ProductImage" WHERE "cloudinaryPublicId" IS NOT NULL GROUP BY 2
     UNION ALL SELECT 'Banner', split_part("cloudinaryPublicId", '/', 1), count(*) FROM "Banner" WHERE "cloudinaryPublicId" IS NOT NULL GROUP BY 2
     UNION ALL SELECT 'Category', split_part("imageCloudinaryPublicId", '/', 1), count(*) FROM "Category" WHERE "imageCloudinaryPublicId" IS NOT NULL GROUP BY 2
     UNION ALL SELECT 'Box', split_part("imagePublicId", '/', 1), count(*) FROM "Box" WHERE "imagePublicId" IS NOT NULL GROUP BY 2
     UNION ALL SELECT 'TeamMember', split_part("imageCloudinaryPublicId", '/', 1), count(*) FROM "TeamMember" WHERE "imageCloudinaryPublicId" IS NOT NULL GROUP BY 2
     UNION ALL SELECT 'StoreSettings.logo', split_part("logoCloudinaryPublicId", '/', 1), count(*) FROM "StoreSettings" WHERE "logoCloudinaryPublicId" IS NOT NULL GROUP BY 2
     UNION ALL SELECT 'StoreSettings.favicon', split_part("faviconCloudinaryPublicId", '/', 1), count(*) FROM "StoreSettings" WHERE "faviconCloudinaryPublicId" IS NOT NULL GROUP BY 2
     ORDER BY 1, 3 DESC;
     ```
     Any `top_folder` other than `giftpacific` is a legacy folder.
  2. Cloudinary Console → Media Library → Folders (or Admin API `GET /folders` / `GET /resources/image?prefix=<folder>/`) to list top-level folders and counts.
  3. Images stored as URLs only (e.g. `Collection` campaign images) have no public id: compare their `/upload/.../<folder>/` URL segment.
- **If legacy folders exist,** a later phase can allow-list the legacy prefix in `isAppCloudinaryPublicId` (one constant) and decide whether the server-side flows should apply the same check — deliberately not done now.

### Operations guide (preserved from the former `docs/OPERATIONS.md`; **never executed against the production database**)

**Launch checklist — information the code cannot know** (Admin → Settings unless noted): real store email/phone/address (shown only when entered); social links; delivery charges for Dhaka/outside/other and the free-delivery threshold (drives announcement bar and cart progress); tax rate (default 0); shipping & returns text in `src/app/(shop)/shipping-returns/page.tsx` (delivery times, 7-day returns, personalised items non-returnable — confirm it matches reality); About copy `src/app/(shop)/about/page.tsx`; **Terms and Privacy pages now exist** (`/terms`, `/privacy`) — owner/legal review required; `NEXT_PUBLIC_APP_URL`; fresh `AUTH_SECRET` (`openssl rand -base64 48`); admin via seed; Cloudinary credentials; theme colours (the old green defaults `#829265`/`#f6f1ea` count as "not customised"); courier manual vs API (do not enable until a real test booking succeeds); **upload the Gift Pacific logo and favicon**.

**Backups.** Use the host's automated backups and confirm retention. Own logical backups: `pg_dump --format=custom --no-owner --no-acl --file="giftpacific-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"`; keep ≥ 14 daily + 8 weekly copies off the DB server, encrypted. Product photos live on Cloudinary, not in the dump (enable its backup/keep originals); secrets are not in the dump (password manager). Verify a dump: `pg_restore --list <file> | head`.

**Restore drill (once before launch, then every few months):** restore into a scratch database, never over production: `createdb giftpacific_restore_test` → `pg_restore --no-owner --no-acl --dbname=giftpacific_restore_test <dump>` → sanity counts (`SELECT count(*) FROM "Order";`, `"Product"`, `SELECT last_value FROM order_number_seq;`) → optionally boot the app against it → `dropdb`. Confirm `order_number_seq` exists and continues from the last number. Real restore: maintenance mode → restore to a **new** database → check → repoint `DATABASE_URL` → orders placed after the backup must be recovered from logs/courier portal/customer messages. Never `migrate reset`/`db push` on production.

**Password recovery (manual; no email).** Verify the person (contact message from the account's email; order number), then on a machine with the production `DATABASE_URL`: `NEW_PASSWORD='A-strong-temp-Pass-1' pnpm user:set-password customer@example.com` (10+ chars with lower, upper, digit; read from the environment so it is not in shell history; outstanding reset tokens are deleted); give it over a trusted channel and ask the customer to change it in Account → Settings. Existing login cookies are stateless and expire on their own. If email is added later: integrate a transactional provider in `src/server/actions/password-reset.actions.ts`, remove the production short-circuit there and on the forgot-password page, add tests.

**Logging.** Failures are one JSON line each on stderr (`level`, `time`, `context`, `message`, `code`, trimmed `stack`, small `extra`); never customer PII, bodies, tokens or keys. Search by `context`: `checkout.place-order`, `upload.cloudinary`, `courier.book`, `courier.book-failed`, `courier.refresh`, `courier.webhook`, `server-action`, `unhandled-request-error`, `config.critical`, `config.warning`. Customer error pages show a Reference (Next.js digest) matching the log. No hosted error tracker, alerting or uptime monitoring exists.

**Routine:** approve/reject reviews (Admin → Reviews); stock via product → *Stock adjustment & history* (reason required; the product form applies only your change as a difference); courier via order → *Courier booking* / *Manual courier entry* (cancelling an order does not cancel the consignment); reports with CSV export (formula-injection-safe, UTF-8 BOM).

## 23. Requirement status matrix

| Area | Implemented in source | Partial | Missing | Known broken | Not verified in a real environment |
|---|---|---|---|---|---|
| Rebrand to Gift Pacific (code, docs, identifiers) | ✔ | | Gift Pacific logo/favicon assets; default share image; PWA icons; `AP-` prefix decision (owner) | | visual check in a browser |
| Branding guard | ✔ (tested) | | | | CI wiring |
| Auth (customer/admin separation, seed, social) | ✔ | | OTP phone verification, email recovery, granular admin permissions | `proxy.test.ts` never runs | browser, real OAuth |
| Catalogue: types, variants, personalisation, attributes | ✔ | variants unstructured JSON; attributes product-level only | dedicated specification model; option axes; variant-level attributes | | editor in browser |
| Combos, boxes, build-your-own | ✔ | | distinct mini-/set-combo types | | browser, PostgreSQL |
| Inventory & procurement | ✔ | | reservation expiry; "reserved" column | | PostgreSQL concurrency (integration tests never run) |
| Orders, statuses, dispatch gate | ✔ | | | | PostgreSQL, browser |
| Advance, trust, manual wallet verification | ✔ | | phone verification | | real data |
| bKash (advance only) | ✔ | online BALANCE/FULL not built; guests cannot pay | official-contract verification; tests for initiate/execute/IPN | | **everything** (never run against bKash) |
| Nagad / Stripe / SSLCommerz | | | all | | |
| Accounting & reports | ✔ | no double-entry ledger; courier remittance not modelled | | | reconciliation vs a real month |
| Refunds (customer request; gateway lifecycle) | ✔ | | | | bKash refund API; migrations 24–28 |
| COD reconciliation | ✔ | | | | PostgreSQL trigger |
| Courier: Steadfast | ✔ | no cancellation, no pickup-store selection | | | **live API** |
| Courier: Pathao, RedX | | | both (no official docs) | | |
| Fraud check (Steadfast) | ✔ | | OTP phone verification | | **live API; official schema** |
| Coupons, campaigns, banners, delivery reward | ✔ | | free-delivery coupon | `campaigns` test stale | browser |
| SEO (meta, JSON-LD, sitemap, robots, redirects) | ✔ | | PWA icons (a minimal name-only manifest now exists); favicon; default share image | | needs DB at build; real crawl |
| Analytics & consent | ✔ | TikTok/LinkedIn unverified | | | real GTM/Pixel accounts |
| Email / SMS notifications | | in-app only | transactional email | | |
| Typecheck | ✔ passes | | | | |
| Lint | | | | **22 errors / 10 warnings** | |
| Production build | | | | fails offline (Google Fonts) | **build never succeeded in the record** |
| Prisma validate / generate | ✔ validate | generate with placeholder engine | | | real engines |
| Migrations | ✔ 28 present | possible checksum drift (1, 22) | | | **none applied from this snapshot; 24–28 never rehearsed** |

## 24. Development roadmap

**The authoritative plan is `MASTER_ROADMAP.md` (Phase 0–11, preserved in full, with the real status of every phase).** Summary: 0 Source audit · 1 Rebranding · 2 Product domain & catalog · 3 Combo/mini/set/box engine · 4 Inventory & procurement · 5 Admin redesign · 6 Customer experience redesign · 7 Order/payment/accounting integrity · 8 Courier & fraud · 9 Marketing & growth · 10 Performance/security/reliability · 11 QA & production release. All phases are currently **Partial**; none is Completed.

The emergency release is a parallel fast-track. Earlier ad-hoc labels used in previous notes map to the master phases as follows (nothing was dropped): "Phase 1.5 environment verification" → **11**; "Provider verification" (Steadfast live, fraud schema, bKash sandbox, online balance/full) → **7 and 8**; "Customer communication" (email, OTP) → **7/9**; "Operations hardening" (reservation expiry, error tracking, cron, E2E) → **4, 10, 11**; old V1.1/V2 wishes (Media Center, free-delivery coupon, store/branch + brand management, store-wise inventory) → **9, 5, 4**.

**Recommended order after the business restarts:** (1) finish Phase 11 environment verification (genuine build, production-copy migration rehearsal, browser smoke, backup/restore drill); (2) Phase 2; then 3 → 4 → the rest per `MASTER_ROADMAP.md`.

## 25. Next roadmap task after the restart — Phase 2: Product / Attribute / Specification / Variant Engine redesign

> **Not started. Do not begin it until the emergency release is complete and stable.**

**Goal:** replace the flat, JSON-based variant model with a structured engine while preserving every business rule in §21 and all existing orders/data.

**Start by reading:** `prisma/schema.prisma` (`Product`, `ProductVariant`, `ProductCustomizationField`, `ProductBundleItem`, attribute models), `src/lib/product-queries.ts`, `src/lib/product-dto.ts`, `src/server/services/{product,admin-product,attribute,cart,order,order-inventory,combo,admin-combo,box}.service.ts`, `src/lib/{combo,inventory-rules,inventory-status,customization,attributes}.ts`, `src/features/admin/*product*`, `attribute-manager.tsx`, `src/features/products/*`, and tests `tests/services/{product,attributes,combo-*,inventory-*}*`.

**Scope to design (design document first, owner sign-off, then implement in small verified steps):**
1. **Option axes:** explicit per-product option groups/values (e.g. Size, Colour) replacing the free-form `ProductVariant.options` JSON; variant = one combination with its own SKU, price, stock, image(s), backorder policy. Generate/validate combinations; prevent duplicates; keep `isDefault`.
2. **Specifications:** a structured specification model (groups, typed values with units, ordering, visibility, filterability) — decide whether it extends the existing `Attribute*` models or replaces them; support variant-level overrides where needed.
3. **Attributes vs specifications vs options:** a clear rule for which is searchable/filterable/priceable/stock-bearing.
4. **Type model:** untangle `ProductType` (STANDARD/VARIANT/PERSONALIZED/BUNDLE) from "has variants", "personalised" and "combo" so they compose (a personalised product with variants should be possible) while keeping the `kind`/`type` CHECK semantics or replacing them in a migration.
5. **Compatibility:** orders, cart items, snapshots (`OrderItem`, `OrderItemComponent`, `CartItemSelection`), combos/boxes slots that reference `ProductVariant`, SEO URLs/slugs, JSON-LD, sitemap, shop filters and admin editor must keep working; existing variants must be migrated by an **additive, re-runnable, rehearsed migration** (no destructive change to applied history; new migration only).
6. **Do not change** pricing rules, stock deduction/restoration, order lifecycle, payment/refund behaviour, the fraud/advance policy, or courier logic as a side effect.
7. **Verification:** extend service tests; add PostgreSQL integration tests for the new constraints; run the full checklist (`check:branding`, typecheck, lint, tests, build) on a machine with internet and a disposable database; browser-check the editor and product page.

**Preconditions before coding Phase 2:** complete the Phase 11 environment-verification items that touch the database (§6.2 checksum check, migration rehearsal), because Phase 2 adds migrations on top of an unverified history.

---

## Appendix A — Verification commands

```bash
pnpm install --frozen-lockfile
export DATABASE_URL="postgresql://unused:unused@localhost:5432/unused"   # validate/typecheck never connect
pnpm exec prisma validate
pnpm check:branding
pnpm typecheck
pnpm lint
pnpm test                                                                # or run the three groups separately for attribution
AUTH_SECRET=<random> NEXT_PUBLIC_APP_URL=http://localhost:3000 DATABASE_URL=<DISPOSABLE db> pnpm build
```
Schema-vs-migrations drift check on an empty disposable database (read-only against it): `pnpm prisma migrate deploy` then `pnpm prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL" --exit-code` (expect only the partial unique index `GatewayTransaction_one_open_per_order`, which Prisma cannot model). Real-DB tests: `TEST_DATABASE_URL=postgresql://… pnpm test` (needs `pg`, §19.2). Seeding: `pnpm db:seed` always needs `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`; it never creates demo data.

When recording failures: change nothing while validating; re-run the single file twice; classify (A type error · B runtime error at a changed call site · C test-double gap · D environment/tooling · E business-logic assertion · F pre-existing (fails on the original archive too)); copy the first 30 lines of the error with secrets removed; finish the whole plan before fixing anything. Do not weaken assertions or disable lint rules to get green.

## Appendix B — Migration rehearsal runbook for migrations 24–28 (preserved; never executed; Windows/PowerShell)

**Rules:** only step 1 touches the demo database and only with read-only statements. Never `migrate dev`, `migrate reset` or `db push` on any real database; never edit an applied migration. **Warning — migration 27** runs `UPDATE "GatewayRefund" SET "submittedAt" = "createdAt" WHERE "status" = 'PENDING' AND "submittedAt" IS NULL`: afterwards every formerly-PENDING refund is treated as UNCERTAIN (never resent; settled only through a bKash status query or an attestation with evidence). **Pause all refund processing** from before the migration until each is reconciled; list them first (1.3) and check each in the bKash dashboard. It also sets `providerConfirmedAt = updatedAt` for SUCCEEDED refunds not yet in accounting. If bKash was never enabled, `GatewayRefund` is empty and nothing changes.

0. **Session helpers** (URLs live only in session variables; Prisma URLs end in `?schema=public`, which `psql`/`pg_dump`/`pg_restore` reject, so strip it; send SQL through here-strings; use a direct, non-pooled connection for `pg_dump`):
```powershell
function To-PgUrl([string]$u) { $u = $u -replace '([?&])schema=[^&]*&?', '$1'; $u.TrimEnd('?','&') }
function Show-Target([string]$u) { $x = [uri]$u; "host=$($x.Host) db=$($x.AbsolutePath.TrimStart('/'))" }   # never prints the password
$env:DEMO_URL  = Read-Host "Demo database URL (read-only use only)"
$env:ADMIN_URL = Read-Host "URL of a server where you may CREATE a database"
```
1. **Read-only inspection of the demo DB.** 1.1 `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;` — expect 28 rows with `finished_at` and no `rolled_back_at` (otherwise **stop**). 1.2 `$env:DATABASE_URL=$env:DEMO_URL; pnpm exec prisma migrate status` ("Database schema is up to date" = all applied). 1.3 (only if migration 25+ exists) `SELECT status, count(*) FROM "GatewayRefund" GROUP BY status;` and `SELECT id, "transactionId", amount, status, "createdAt" FROM "GatewayRefund" WHERE status='PENDING';` — save the counts. **Also run the checksum comparison from §6.2.**
2. **Disposable copy:** `pg_dump --format=custom --no-owner --no-privileges --file=demo.dump (To-PgUrl $env:DEMO_URL)`; `"CREATE DATABASE giftpacific_rehearsal;" | psql -v ON_ERROR_STOP=1 (To-PgUrl $env:ADMIN_URL)`; set `$env:REHEARSAL_URL`, **refuse unless the database name is `giftpacific_rehearsal` and it differs from the demo URL**; `pg_restore --no-owner --no-privileges --dbname=(To-PgUrl $env:REHEARSAL_URL) demo.dump`. `demo.dump` contains customer data: never commit/share; delete it and drop the rehearsal DB afterwards.
3. **Rehearse:** with the same name guard, `$env:DATABASE_URL=$env:REHEARSAL_URL; pnpm exec prisma migrate status; pnpm db:deploy; pnpm exec prisma migrate status` (must end "up to date").
4. **Verify (read-only):** 4.1 drift: `pnpm exec prisma migrate diff --from-url $env:REHEARSAL_URL --to-schema-datamodel prisma/schema.prisma --script` — expect empty or only `GatewayTransaction_one_open_per_order`; anything else is drift to report, not to "fix" by editing migrations. 4.2 objects: trigger `CourierCodEntry_append_only` (`pg_trigger`), partial index (`pg_indexes` for `GatewayTransaction`), `GatewayRefund` columns `submittedAt, providerConfirmedAt, accountingRecordedAt, resolvedAt, resolvedById, resolutionNote, incidentId, resolutionEvidence, proposedOutcome, proposedTrxId, proposedConfirmedOn, proposedEvidence, proposedNote, proposedById, proposedAt`. 4.3 counts of `"Order"`, `"Payment"` and refunds per status identical to step 1; `pending_without_submittedAt = 0`. 4.4 inside `BEGIN; UPDATE "CourierCodEntry" SET amount = amount; ROLLBACK;` the trigger must raise (needs rows). 4.5 integration tests per §19.2 on the rehearsal copy (`pg` in a throw-away project copy).
5. **Recovery:** migrations are additive; before any real migration take a fresh `pg_dump --format=custom` and keep it; recovery = restore into a new database and repoint the app. A migration that fails half-way is recorded as failed and `migrate deploy` refuses to continue: do not `migrate resolve` blindly — inspect, restore from backup, ask for help. Rolling app code back after migration 27 is safe only while refunds stay paused.
6. **Live:** only after steps 1–4 pass on the copy and the owner approves: `pnpm db:deploy` with the live URL set for that one command only.
For manual browser checks on a rehearsal copy: do not place real orders, start any bKash payment, send any refund, press any courier "Book" button or enable any provider; with nothing configured those controls must show as unavailable (that is part of the check). Use `pnpm user:set-password <admin-email>` with `NEW_PASSWORD` typed at a prompt, on the rehearsal copy only.

## Appendix C — Accounting definitions, extra detail

Beyond §14: the sales/channel reports, dashboard cards/chart and both CSV exports are built from the same functions (`orderFacts` / `buildFinancialSummary`); *Reports → Channels* with no filters has a "Combined" column equal to the Accounts page. Marketplace receivable = total − advance paid to us − commission/payment fee withheld by the marketplace − payouts received; profit is an *estimate* until every sold line has a unit cost and every sold marketplace order has a commission entry (enter 0 if none). A refund on an excluded order is cash-only; on a counted sale it is compensation. Restocking is tied to the order line and capped by what is still out.

Surfaces and their single source: Admin → Accounts = `getAccounting` → `buildFinancialSummary`; Accounts CSV (summary + per-order, TOTAL row equals the summary) = `summaryToCsv`/`ordersFinancialCsv`; dashboard finance cards and order-value chart = `getAccounting` (this month) / `orderValueByDay`; Reports → Channels = `loadAccountingInputs` → `aggregateChannelReport`; Reports → Sales and its CSV use the same order-selection rule (`orderDateWhere`). Marketplace commission and payment fee are *withheld from the payout*: a profit cost, **not** a second cash outgoing; courier, packaging and other costs are cash we pay. Settlement state: PENDING (no payout), PARTIAL, SETTLED (payouts ≥ expected); a payout counts only once a person records amount + date.

Formulas: `profit = net sales + delivery billed − COGS − all order costs − losses − return/extra courier fees − compensation − operating expenses`; `cash in = verified advances + COD collected + payouts received`; `cash out = refunds + expenses + order costs paid by us (not withheld fees) + incident courier fees + procurement purchases`.

Worked example (no double counting): marketplace order total 3,060, advance paid to us 500, commission + payment fee 100 → `expected payout = 3,060 − 500 − 100 = 2,460`. The marketplace pays 1,000, later 1,460. After the first payout: cash in = 500 + 1,000 = 1,500; receivable 1,460; PARTIAL. After the second: cash in = 2,960; receivable 0; SETTLED. `cash in + fees withheld = 2,960 + 100 = 3,060` = the order value: every taka counted once.

## Appendix D — Advance-hardening migration notes (migration 20)

Adds `Order.advanceWaivedAt`, `trustReviewRequired/ReviewedBy/ReviewedAt/ReviewNote`, `StoreSettings.trustReviewEnabled/advancePolicyUpdatedAt/By`, table `AdminAuditEvent`, and a NOT VALID CHECK (`0 ≤ advancePaid, advanceRequired ≤ total`, enforced for new rows and later updates). Back-fill: only PENDING orders whose stored snapshot says `needsReview` get `trustReviewRequired = true`. Pre-flight on a production copy: `SELECT count(*) FROM "Order" WHERE "advancePaid" > "total" OR "advanceRequired" > "total" OR "advancePaid" < 0 OR "advanceRequired" < 0;` — a violating row fails any later UPDATE until corrected. With the review rule on (default) every order from a new/guest customer inside an advance zone needs a recorded review before confirmation; turn it off in Admin → Advance if undesired. Audit events: `ADVANCE_VERIFIED`, `ADVANCE_REJECTED`, `ADVANCE_WAIVED`, `TRUST_REVIEWED`, `ADVANCE_POLICY_CHANGED`, `FRAUD_RECHECK`; a waiver needs a ≥ 5-character reason, once per order, only while PENDING with an outstanding advance, and is a decision, not money.

## Appendix E — Phase history (condensed)

Phase 1–3 (earlier sessions): storefront/admin foundations, accounting + marketplace orders, inventory/procurement integrity (Phase 2), partial payments + trust (Phase 3; baseline 601 tests / 575 pass / 2 fail / 24 skipped). 4: product editor tabs, cart drawer, admin navigation. 5: SEO. 6: customer experience (wishlist, recently viewed, reviews, Q&A, notifications, Buy Again, abandoned carts). 7: courier COD reconciliation, bulk booking, payment reconciliation view. 7.1–7.1.4: bKash advance payments, refund lifecycle, attestation. 7.2: Pathao/RedX deliberately not implemented. 7.3: fraud-check pipeline, service-level authorisation. 7.4/7.4.1: fraud-check hardening, BD phone validation, Steadfast fraud adapter. 7.4.2: Gift Pacific storefront design restored over 7.4.1 functionality (21 design files). Earlier Next.js 16 build fix: every export of a `"use server"` file must be `async function` (attribute, external-order and team/career actions were rewritten that way; keep this rule). **Phase 1 (rebrand, cleanup, guard, consolidation): this document.** An older snapshot named `latest-…zip` with a different file set was once mentioned in the notes; it is not part of this repository — if it is ever the deployed code, port the later phases onto it deliberately.
