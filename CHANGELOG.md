# Changelog

Newest first. Earlier phases (P1–P7.2) are described in `HANDOFF_GIFTPACIFIC.md`.

## P7.3.5 — Build type-error fixes (typecheck on the user's machine)
- Fixed 5 TypeScript errors that stopped `pnpm build`. All were in older code (not P7.3); behaviour is unchanged, types only:
  - `src/features/admin/courier-diagnostics.tsx`: the connection-test result `{ success, message }` is mapped to the `{ ok, message }` shape the state expects.
  - `src/server/services/courier-cod.service.ts`: `outcome: { in: [...] as string[] }` (a readonly tuple from `as const` is not accepted by Prisma).
  - `src/server/services/courier.service.ts`: `shipmentWhere()` is typed `Prisma.OrderWhereInput` and no longer uses `as const`.
  - `src/server/services/fraud-report.service.ts` and `fraud-review.service.ts`: order status lists typed `OrderStatus[]`.
- Not run here (no network / `node_modules`): `tsc`, lint, build. Re-run `pnpm typecheck && pnpm lint && pnpm build`; if another error appears, send it.

## P7.3.4 — Final audit & delivery
- Audited P7.3.1-P7.3.3: Gmail SMTP config, admin test e-mail, queue/retry, credential exposure, authorization. No issues found; **no source code changed**.
- Verified: 65/65 P7.3 tests pass (unit + service). **Not verified here:** `typecheck`, `lint`, `build`, Postgres migration, live Gmail (sandbox had no network or `node_modules`). Run `pnpm install && pnpm typecheck && pnpm lint && pnpm build` before deploying.
- Updated: `HANDOFF_GIFTPACIFIC.md` (audit result, exact setup steps), this changelog.

## P7.3.3 — E-mail queue foundation
- Inspected: the project had no generic job queue or worker process. It does have a proven PostgreSQL pattern (`TrackingEventLog`: unique key, claim, backoff, stale-claim recovery) driven by an external scheduler with `Bearer CRON_SECRET` (`/api/tracking/retry`, `/api/courier/reconcile`), plus `RateLimitBucket`, `after()` and the single send function `sendSmtpMail()`. All reused; **no Redis, no new dependency**.
- Added: `EmailJob` table + `EmailJobStatus` (`PENDING | PROCESSING | SENT | FAILED`), migration `20261128000000_email_queue_p733` (additive; rollback in the file).
- Added: `src/server/services/email-queue.service.ts`: `enqueueEmail` (one e-mail, best-effort `after()` kick), `enqueueEmails` (bulk: inserts only, never waits for SMTP, max 5,000 per call), `deliverEmailJob`, `processEmailQueue`.
- Added: `src/lib/email/queue-policy.ts` (pure: retry backoff, failure classes, send limits, de-duplication key, input validation).
- Added: `POST|GET /api/email/queue` (Bearer `CRON_SECRET`; counts-only response).
- Retry: temporary failures retry after 1 min, 5 min, 30 min, 2 h, then FAILED (5 attempts). A refused recipient fails at once. A broken SMTP setup (login/TLS/not configured) pauses the queue for 30 min without using up attempts. Jobs queued over 7 days expire unsent.
- Duplicates: unique `dedupeKey` (hash of kind + caller-chosen parts, case-insensitive, no raw address); `createMany skipDuplicates`.
- Limits: per run (20), per hour (100), per day (400), configurable via `EMAIL_QUEUE_*`; individual e-mails drain before bulk.
- Privacy/logging: body removed once SENT (or expired); SENT rows purged after 30 days, FAILED after 60. Logs and stored errors hold only job id, kind, fixed error code and attempt number.
- Tests: `tests/unit/email-queue-policy.test.ts` (8), `tests/services/email-queue.test.ts` (29). Test harness: `emailJob` table added to `tests/setup/fake-db.ts`.
- Changed: `.env.example` (queue block), `prisma/schema.prisma`, docs.
- Not added: nothing enqueues e-mail yet (the admin SMTP test e-mail still sends directly, by design), no campaign UI, no bulk selection, no abandoned-cart automation, no admin screen for failed jobs, no templates.

## P7.3.2 — Admin SMTP test email
- Added: "E-mail (SMTP)" panel on the existing **Admin → Store settings** page (`src/features/admin/smtp-settings-panel.tsx`): sender name, sender e-mail, server/encryption, masked login, "password set" flag, connection status badge, **Check connection** and **Send test email** (recipient input, pre-filled with the signed-in admin's address) with real success/failure feedback.
- Added: `sendSmtpMail()` in `src/lib/email/smtp.ts` (the single send function; one validated recipient, TLS required, closes the connection, fixed error codes/messages), `validateRecipientEmail()`/`maskEmail()` in `src/lib/email/config.ts`.
- Added: `src/server/services/admin-smtp.service.ts` (status DTO built field by field, connection check, test e-mail, audit event `SMTP_TEST_EMAIL` with masked recipient) and `src/server/actions/admin-smtp.actions.ts` (`requireAdmin()` first).
- Added: rate limits `smtpTestEmailAdmin` (10/hour/admin) and `smtpCheckAdmin` (30/hour/admin); new failure codes `recipient_rejected`, `send_rejected`; SMTP 530 now maps to `auth_failed`.
- Tests: `tests/services/smtp-admin.test.ts` (16).
- Changed: settings page (one panel added; existing settings form untouched), `.env.example` comment, docs.
- No schema change / migration. No new dependency beyond P7.3.1's `nodemailer` (still: run `pnpm install`).
- Not added: e-mail templates, queue, order/customer e-mails, editing SMTP settings from the UI (credentials stay in the server environment).

## P7.3.1 — Gmail SMTP audit & configuration
- Added: `src/lib/email/config.ts` (SMTP env parsing/validation, secret-free summaries), `src/lib/email/smtp.ts` (the single Nodemailer transport factory + safe connection verification), `scripts/verify-smtp.ts` (`pnpm smtp:verify`), tests `tests/unit/smtp-config.test.ts`.
- Added dependencies: `nodemailer`, `@types/nodemailer` (lockfile NOT regenerated: run `pnpm install`).
- Changed: `.env.example` (SMTP_* block), `src/lib/production-checks.ts` (warns on invalid SMTP settings, by variable name only), `package.json` (script + deps), docs.
- Not added: any e-mail sending, campaigns, templates, queue or admin UI.

## P7.2 — Incomplete checkout recovery
- See `HANDOFF_GIFTPACIFIC.md` → P7.2.

## Event-driven e-mail sending (Vercel Hobby)
- Send now queues the campaign and then sends ONE bounded batch (max 20, never past the hourly/daily limits or the request time budget) inside the same request; the rest stays Pending. New "Continue sending" button for a SENDING campaign.
- Abandoned-cart reminders: admin selects carts on /admin/abandoned-carts and clicks "Send reminders" (consent, suppression, unsubscribe link and headers enforced; one reminder per abandonment).
- New Email marketing > Send queue page: Pending / Failed filters and multi-select Retry (bounded, one extra attempt per click, never SENT, never locked).
- No cron, timer, after() or background work was added. Pages hosting these actions declare `maxDuration = 60`.
