# RELEASE CHECKLIST — Gift Pacific emergency production release

**Status of this release candidate: NOT CLEARED FOR PRODUCTION.** The source-level work is finished and verified as far as this environment allows (see `RELEASE_AUDIT.md`). Production clearance needs the **owner actions below that only you can perform** (production database, production hosting settings, Google Fonts/internet build). Nothing here has been run against your production system.

Legend — **[MANDATORY]** must be done before accepting customer orders · **[OPTIONAL]** recommended · **[BLOCKED]** cannot be verified without production access · **[OWNER DECISION]** a business choice the software must not make for you.

---

## 0. The shortest safe path (summary)

1. Back up the production database. **[MANDATORY]**
2. Run the read-only migration check (§4). **[MANDATORY, BLOCKED until you run it]**
3. Confirm production settings (§2) and the business policy items (§1). **[MANDATORY]**
4. Build and deploy this ZIP on a host with internet + database access (§5). **[MANDATORY]**
5. Run the post-deployment smoke tests (§6), including one real COD test order that you cancel. **[MANDATORY]**
6. Keep the fallback procedures (§8) ready for the first days. **[OPTIONAL but recommended]**

---

## 1. Owner decisions and confirmations (do not skip)

| ID | Item | Why | Action |
|---|---|---|---|
| O-1 | **Advance payment policy** — the software default is `advanceEnabled = false`. | With it off, outside-Dhaka orders require **no** advance and nothing forces a wallet claim. Verified on real PostgreSQL (release scenario "ADVANCE DEFAULT"). With it on, checkout without a payment claim is refused and the order cannot be confirmed until staff verify the advance. | Open **Admin → Advance & trust** and confirm the toggle, zones (default Outside Dhaka), amount (default ৳200), thresholds and the "review new customers" rule match your policy. **OWNER ACTION REQUIRED — not confirmed.** Do not rely on any default. |
| O-2 | **Website sales channel row** | Migration 6 inserts the reference row `channel_website`. If it is missing, **every checkout fails** with a foreign-key error (observed when the row was removed in testing). | Run the SQL in §6.2 (check 3). If it returns no row, **stop and ask for approval**; the safe remediation is in §6.3. Do not insert data on your own. |
| O-3 | **Gift Pacific logo and favicon** | None exist in the repository; the site shows the store name as text and browsers get no favicon. | Upload both in **Admin → Settings** when you have the real files. **[OPTIONAL]** — not a launch blocker. |
| O-4 | **Order-number prefix `AP-`** | Kept unchanged by your decision (it is derived from the discontinued brand). | None for launch. |
| O-5 | **Store name in the database** | The migration that once renamed an old store name is now a no-op; a database may still hold the old name. | Check §6.2 (check 4); change it in **Admin → Settings** if needed. |
| O-6 | **Terms / Privacy / Shipping & Returns text** | They describe real behaviour but are not legal advice. | Review before launch. **[MANDATORY if not already reviewed]** |
| O-7 | **Courier and payment providers** | Steadfast has never been run against the live API; bKash never against bKash. | Keep `BKASH_ENABLED=false`, `COURIER_AUTO_BOOK=false`, leave `FRAUD_CHECK_PROVIDER` unset until each is tested (§8). |

---

## 2. Production environment variables (names only — never put values in files or chat)

Set these in the hosting provider's environment settings. `NEXT_PUBLIC_*` values are baked in **at build time**, so they must be present in the build environment too.

| Variable | Requirement | Notes |
|---|---|---|
| `DATABASE_URL` | **[MANDATORY]** PostgreSQL URL | Must also be reachable **during the build** (the sitemap queries the database while building). A pooled/serverless-friendly connection string is fine; use the database's own backups. |
| `AUTH_SECRET` | **[MANDATORY]** random, **at least 32 characters** | Generate with `openssl rand -base64 48`. The code only enforces 16, but the startup check logs a *critical* line below 32 or for a placeholder. **Do not change it on a live site unless necessary: changing it signs everyone out.** If your current secret is 16–31 characters, replace it during a quiet moment and accept the sign-out. |
| `NEXT_PUBLIC_APP_URL` | **[MANDATORY]** `https://your-domain` (no trailing slash) | Used for canonical URLs, sitemap, OAuth/payment/courier callbacks and the cookie "secure" decision. `localhost` logs a *critical* line. |
| `UPLOAD_PROVIDER` | **[MANDATORY if you upload product photos]** set to `cloudinary` **explicitly** | The code default is `local`, which cannot work on a serverless host. Also set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. |
| `NEXT_PUBLIC_APP_ENV` | `prod` (not `demo`) | `demo` exposes the roadmap page `/docs`. |
| `NEXT_PUBLIC_CURRENCY`, `NEXT_PUBLIC_CURRENCY_SYMBOL` | optional | Defaults are BDT / ৳. |
| `CRON_SECRET` | optional | Blank disables `/api/courier/reconcile` (it answers 401 anyway without the secret). |
| `COURIER_AUTO_BOOK` | **`false`** | Keep false until a real booking has succeeded. |
| `COURIER_PROVIDER` / `STEADFAST_*` | optional, only when you are ready to test Steadfast | Courier controls stay unavailable when credentials are missing (that is the intended safe state). |
| `BKASH_ENABLED` | **`false`** | bKash is unverified. Enabling it logs a *critical* line by design. |
| `FRAUD_CHECK_PROVIDER` | leave **unset** | Unset = every order scores 50 (standard advance, staff review); checkout is never blocked. |
| `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_META_PIXEL_ID`, `META_CONVERSIONS_API_TOKEN` | optional | Real accounts never verified. |
| `GOOGLE_*`, `FACEBOOK_*` | optional | Social login; never verified against real providers. |
| `RATE_LIMIT_ENABLED` | leave default (on) | |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | only for the one-time admin seed | Remove afterwards. Do not seed a database that already has an admin. |
| `STRIPE_*`, `SSLCOMMERZ_*` | do not set | Not integrated. |

After the first start, read the host's logs for `config.critical` / `config.warning` lines. **There must be no `config.critical` line.**

---

## 3. Database backup **[MANDATORY]**

1. Use the managed provider's snapshot/backup feature **and** confirm it finished (note the time).
2. Also take your own logical dump from a trusted machine (replace the URL; `?schema=public` must be removed from the URL for `pg_dump`):
   ```powershell
   $env:PGURL = Read-Host "Production DATABASE_URL (this session only)"
   $u = ($env:PGURL -replace '([?&])schema=[^&]*&?','$1').TrimEnd('?','&')
   pg_dump --format=custom --no-owner --no-acl --file="giftpacific-$(Get-Date -Format yyyyMMdd-HHmmss).dump" $u
   pg_restore --list (Get-ChildItem giftpacific-*.dump | Sort-Object LastWriteTime | Select-Object -Last 1).FullName | Select-Object -First 5
   ```
3. Store the dump encrypted and off the database server. It contains customer data — never put it in the project folder or the ZIP.
4. (Strongly recommended, once) prove the backup restores into a **scratch** database, never over production — see `HANDOFF_GIFTPACIFIC.md` → *Operations guide → Restore drill*.

---

## 4. Migration verification — read-only **[MANDATORY, BLOCKED until the owner runs it]**

**Why:** two historical migrations (`20261008000000_init` and migration 22, the store-name default) had their text edited at some point. If they were already applied to production before the edit, the checksum stored in the database no longer equals the file. Prisma stores the SHA-256 of each `migration.sql`. Nothing in this ZIP edits any migration (verified: byte-identical to the baseline).

**What this procedure does:** it only runs one `SELECT` (the session is forced read-only) and reads local files. It changes nothing.

### 4.1 PowerShell (run inside the extracted project folder, where `prisma\migrations` exists; requires `psql`)

```powershell
# READ-ONLY migration checksum comparison. Writes nothing to the database.
$url = Read-Host "Production DATABASE_URL (kept in this session only)"
$pg  = ($url -replace '([?&])schema=[^&]*&?','$1').TrimEnd('?','&')   # psql rejects Prisma's ?schema=public
$env:PGOPTIONS = "-c default_transaction_read_only=on"                 # the server refuses any write in this session

$sql  = 'SELECT migration_name, checksum, (finished_at IS NOT NULL), (rolled_back_at IS NOT NULL) FROM "_prisma_migrations" ORDER BY migration_name;'
$rows = & psql $pg -X -A -t -F '|' -v ON_ERROR_STOP=1 -c $sql
if ($LASTEXITCODE -ne 0) { throw "psql failed - nothing was changed. Fix the connection and retry." }

$db = @{}
foreach ($r in $rows) { if ($r.Trim()) { $p = $r -split '\|'; $db[$p[0]] = @{ sum = $p[1]; finished = $p[2]; rolledBack = $p[3] } } }

$bad = 0
foreach ($d in (Get-ChildItem prisma\migrations -Directory | Where-Object { $_.Name -match '^\d{14}_' } | Sort-Object Name)) {
  $file = (Get-FileHash (Join-Path $d.FullName 'migration.sql') -Algorithm SHA256).Hash.ToLower()
  if (-not $db.ContainsKey($d.Name))            { "NOT APPLIED    $($d.Name)"; continue }
  $e = $db[$d.Name]
  if ($e.rolledBack -eq 't')                    { "ROLLED BACK    $($d.Name)"; $bad++ }
  elseif ($e.finished -ne 't')                  { "NOT FINISHED   $($d.Name)"; $bad++ }
  elseif ($e.sum -eq $file)                     { "MATCH          $($d.Name)" }
  else                                          { "MISMATCH       $($d.Name)`n    database: $($e.sum)`n    file    : $file"; $bad++ }
}
foreach ($k in $db.Keys) { if (-not (Test-Path "prisma\migrations\$k")) { "IN DATABASE ONLY $k"; $bad++ } }
"`nproblems: $bad   (0 = every applied migration matches this ZIP)"
Remove-Item Env:\PGOPTIONS
```

### 4.2 Equivalent SQL (read-only) if you prefer a SQL client

```sql
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations" ORDER BY migration_name;
```
Compare each `checksum` with the table in §4.4 (these are `sha256sum prisma/migrations/<folder>/migration.sql` of the files in this ZIP; the files use LF line endings — keep them that way, do not re-save them in an editor that converts line endings).

### 4.3 How to read the result

| Result | Meaning | Action |
|---|---|---|
| All `MATCH` (and any `NOT APPLIED` are migrations you expect to deploy now) | No drift. | Continue to §5. |
| `MISMATCH` on `20261008000000_init` and/or migration 22 | The file was edited after it was applied. **The schema itself is not affected** (both migrations' effects are satisfied by `schema.prisma`). | **Stop and send the output to your developer. Do not run `migrate reset`, `migrate dev`, `db push` or `migrate resolve`.** The safe options are in `HANDOFF_GIFTPACIFIC.md` §6.2 (restore the original file text that was really deployed, or — only with your written approval, in a transaction on a backed-up database — record the accepted checksum). Whether `prisma migrate deploy` tolerates a mismatch is **unverified**; treat a mismatch as a blocker until resolved. |
| `NOT FINISHED` / `ROLLED BACK` | A migration failed earlier. | **Stop.** Do not deploy. |
| `IN DATABASE ONLY` | The database has a migration this ZIP does not. | **Stop.** You are probably deploying an older version. |

### 4.4 Repository checksums (this ZIP, 28 migrations)

<!-- branding-guard:allow-start -->
```
3ef94f52882684aff775096c8059ecb035750fea404594a98745c755b4922485  20261008000000_init
29458ffd407338d34ff9508a1a0c6c65c559c9217da7e425e92a303c8241ef20  20261010000000_courier_reviews_campaigns_stock
a62f88ca3a098431b7c13b7c9c2e21a02869b0f0dcb1db71981fd2e5443db7d0  20261012000000_brand_color_defaults
c81f2818a3a66039cd66bae2bd3ad71b14b4425ee006b7f77ec104b5e36ea250  20261017000000_drift_fix_ratelimit_unitcost
dbd24562f1b7c6c2c2150058f3dd7d7bc2a1c42a344eae5e8cb5876fdfa6fb37  20261018000000_combos_attributes_team_social_reviews
0783375ed8bedf44736330c54b5332f5c61291df7d2ca7b10c1ea9333e50af13  20261019000000_channels_costs_settings
a69b19fd1a7396d9b8fecac37e7fc5d32d79e5256a9997af02b4a00d2eb85020  20261101000000_seo_keywords
1fd4fddf1126891ac1c446e2347befb95f6a7acc9929ea18ad040dfecbecabd2  20261102000000_boxes
05b7369fc059478522eb8003cc9c943892e68cde4f0219994f63632f2d9ebd7e  20261103000000_combo_slot_source
6d89add5db22e71e3907f519278488c4e1b7c4e667def7d33670532175328cf2  20261104000000_box_managed_product
47c126445b1ee666d4ccd4252d3a5138aa575e2041a4cc082ebe8f4818a097c6  20261105000000_inventory_procurement
cb04a0a5b0507578c4386db5def98bd990414dfbb133e8ff6d15702eed930975  20261106000000_delivery_reward
09cde3544a5dda04ace7a78d6f914e5e32f717629ac60e1ef079b6db75829f1d  20261107000000_advance_payment_trust
172164fecb52451bd523bbbcf87f22d81092bd86cec3c8d947123a3102131b8b  20261107000001_advance_payment_columns
8b502da5aab1452119ea14a3effc8ef91826f38448634b6b7e16e929341ac6cd  20261108000000_accounting_incidents_settlement
4d9b7802e994d81f4f0f7ee4687c3e0a67776af5925e1e9f21b0b421a197c31f  20261109000000_settlement_partial_status
598204704b1df27ab6a9ec62eb90f5239bfe52cf08ed80801a5515602908fe6b  20261109000001_marketplace_settlements
0752cdce68d8a7cdcfc7a90fb2d4c4bc095872a928e6a8b878617e6b8238b469  20261110000000_incident_discard_effect
58810145adad18f780cc4c0872b5efa9835f7a56cb4d76f119fc37a717e95e23  20261110000001_stock_integrity
9b9d58b1b4f629289787483b95754e0e128b575d0b74b4ee535b5f01409305cc  20261111000000_advance_hardening
77d3700a983e6a15faee0c9bb58a4dc13bec01cf0ec74398d7c79f6fcef29592  20261112000000_seo_phase5
c4fd8c86ee042ddfc9976a757b71cd1d9062a92f79da9478f5aef86ce618bd8f  20261113000000_brand_default_aura_petals
bb5e6286e2f82637607ffdcab0f64c80fc9e293a169a0fd1998473a943f79076  20261114000000_customer_experience_phase6
cb9ce05aca8569b63e561a187675130973746ff7dc95a767ee66825c6ff6ec67  20261115000000_courier_cod_reconciliation_phase7
9443c65437f227520089831727b8c5be9c98db83676c9ddd3f47f7e55317d46d  20261116000000_gateway_transactions_phase71
4442f758c576dfc0d78661439dfb30546a98fa5e68c9405e79e1386c5d041a6d  20261117000000_gateway_refund_accounting_phase711
080536c210b154f811d2fab990a33bbd2cdd4f12dfaaeee454a9d17698e4df6a  20261118000000_gateway_refund_lifecycle_phase713
e381dd789cce990f667062ea2c8662e798a09d3b287f60426a352f5ea6d3d1d5  20261119000000_refund_attestation_phase714
```
<!-- branding-guard:allow-end -->

---

## 5. Build and deploy (after §3 and §4) **[MANDATORY]**

**Requirements of the build machine:** internet access (the site's four Google fonts are downloaded during `next build`; this has **never succeeded in the verification environment** because it had no access to Google Fonts — see `RELEASE_AUDIT.md`), Node 22, pnpm 11.24.0, and a reachable `DATABASE_URL` with the variables of §2.

```bash
pnpm install --frozen-lockfile
pnpm check:branding && pnpm exec prisma validate && pnpm typecheck && pnpm test      # expect: 4 known failing tests (see audit), nothing else
pnpm build                                                                            # MUST succeed on your host — the first genuine build proof
```
1. **Do not run `pnpm db:deploy` yet** unless §4 showed `NOT APPLIED` migrations that you intend to apply and you approved them. If you do: back up first (§3), then `pnpm db:deploy` (= `prisma migrate deploy`; it applies only pending migrations and never resets anything). Migrations 24–28 are additive but have never been applied to your database; read `HANDOFF_GIFTPACIFIC.md` §6.2 and Appendix B first, and **keep refund processing paused during that rollout**.
2. Deploy the build (e.g. Vercel: push/upload, set the environment variables first). Keep the **previous** deployment available for rollback (§7).
3. Immediately read the startup logs for `config.critical` (must be none).

---

## 6. Post-deployment smoke tests **[MANDATORY]**

### 6.1 HTTP checks (replace the domain)

| URL | Expected |
|---|---|
| `/`, `/shop`, a real `/products/<slug>`, `/cart`, `/checkout`, `/login`, `/about`, `/contact`, `/terms`, `/privacy` | HTTP 200 |
| `/account` (signed out) | 307 → `/login?redirect=…` |
| `/admin`, `/admin/orders` (signed out) | 307 → `/admin/login?redirect=…` |
| `/admin/login` | 200 |
| `/docs` | 307 → `/` |
| `/api/courier/reconcile` (no secret) | 401 |
| any page, response headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` |
| `/robots.txt` | 200 |
| `/sitemap/0.xml` | 200 (**`/sitemap.xml` returns 404 — known P1; submit `/sitemap/0.xml` to Search Console**) |

```powershell
(Invoke-WebRequest https://YOUR-DOMAIN/ -Method Head -MaximumRedirection 0).Headers | Format-List 'X-Content-Type-Options','X-Frame-Options','Referrer-Policy'
```

### 6.2 Database checks (read-only; run in a SQL client or with `psql` and `PGOPTIONS="-c default_transaction_read_only=on"`)

```sql
-- 1. every migration finished (expect 0 rows)
SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
-- 2. the order-number sequence exists (expect one row)
SELECT last_value FROM order_number_seq;
-- 3. the website sales channel exists (expect one row)  <-- required for checkout
SELECT 1 FROM "SalesChannel" WHERE id = 'channel_website';
-- 4. store identity and the advance policy as currently configured (read it; confirm with your policy)
SELECT "storeName", "advanceEnabled", "advanceZones", "advanceStandardAmount", "advanceReducedAmount" FROM "StoreSettings";
-- 5. an active admin exists, and no stock is negative (expect 0)
SELECT count(*) FROM "User" WHERE role = 'ADMIN' AND "isActive" = true;
SELECT count(*) FROM "Product" WHERE stock < 0;
```
(If a column name in check 4 differs in your version, run `SELECT * FROM "StoreSettings";` instead.)

### 6.3 If check 3 returns no row — **do not improvise**
Checkout cannot work without it. Report it to your developer and wait for approval. The safe remediation is a single additive `INSERT` of the website channel row exactly as migration `20261019000000_channels_costs_settings` defines it (open that file and copy its `INSERT INTO "SalesChannel"` statement); it must be reviewed and approved by you before it is run on production, after a backup.

### 6.4 Manual smoke test with one real COD order **[MANDATORY]**
Use a cheap in-stock product and your own phone number.
1. Note the product's stock in **Admin → Products**.
2. Place a **Cash on Delivery** order inside Dhaka as a guest (or a test customer). Expect the confirmation page; the order number looks like `AP-YYYYMM-NNNNNN`.
3. In **Admin → Orders** find it; total = item price + delivery charge; stock dropped by the ordered quantity.
4. If your advance policy is on and you choose an outside-Dhaka address, confirm checkout **demands** the wallet and transaction id.
5. Cancel the test order in the admin (status Cancelled) and confirm stock returned **exactly once**.
6. Sign in as a test customer and confirm that only that customer's own orders are visible.
7. Open **Admin → Courier**: it must show courier booking as unavailable/manual if you have not configured Steadfast.

---

## 7. Rollback

| Situation | Action |
|---|---|
| The new deployment misbehaves, **no migration was applied** | Re-point/rollback the host to the previous deployment (Vercel: *Instant Rollback*). Data is untouched. |
| A migration **was** applied | Migrations in this project are additive. The previous app version normally still runs, **except**: after migrations 24–28 the old code does not know the new refund lifecycle — keep refunds paused. Prefer rolling forward with a fix. |
| Data damage | Restore the backup of §3 into a **new** database, verify, then repoint `DATABASE_URL`. Orders placed after the backup must be recovered from the host logs, courier portal and customer messages. Never `migrate reset`, `db push` or destructive SQL on production. |
| Wrong environment value | Fix it in the host settings and redeploy (remember `NEXT_PUBLIC_*` are baked at build time). |

---

## 8. Safe operational fallbacks (all work without any unverified integration)

- **Payments:** Cash on Delivery works out of the box. If you want advances, use the **manual wallet claim**: the customer enters the wallet and transaction id; staff verify it against the wallet statement in **Admin → Orders → Advance & trust**. Never confirm an order whose advance is unverified. bKash stays off.
- **Courier:** use **Manual courier entry** on each order (courier name + tracking number/URL), then update the status by hand. API booking appears only after Steadfast credentials are configured and has never been tested live; test it with **one** real parcel before enabling anything else, and keep `COURIER_AUTO_BOOK=false`.
- **Fraud check:** off. Every order gets score 50; review new customers by phone before dispatch.
- **Orders received outside the website (WhatsApp, Facebook, phone):** enter them at **Admin → Orders → External** so stock and accounting stay correct.
- **Password reset:** there is no email. Customers who forget their password contact you; use the operator command in `HANDOFF_GIFTPACIFIC.md` §22 (*Password recovery*).
- **If checkout breaks at launch:** put a notice on the site (Admin → Banners / announcement), take orders by phone/WhatsApp using the External-order screen, and send the host's error log lines (`checkout.place-order`) to your developer.
- **Stock:** stock is decreased when an order is placed and returned only if the order is cancelled before dispatch; unpaid pending orders keep their stock until cancelled (cancel abandoned ones daily).

## 9. Known limitations to accept at launch (details in `RELEASE_AUDIT.md`)
No email/SMS; no product-variant redesign; `/sitemap.xml` 404 (use `/sitemap/0.xml`); unknown/draft product URLs answer HTTP 200 with a "not found" page marked `noindex` (SEO only); no Content-Security-Policy; Terms/Privacy need your review; no Gift Pacific logo/favicon assets yet; hero carousel has no pause button (accessibility gap); 4 known failing tests and 22 lint errors, none in the order, payment or stock paths.
