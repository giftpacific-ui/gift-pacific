import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { logServerError } from "@/lib/logger";

/**
 * Fixed-window request throttling backed by PostgreSQL (no Redis).
 *
 * - Keys are SHA-256 hashes of `<rule>|<identifier>` plus the app secret, so no raw
 *   IP address, email or password is ever written to the database.
 * - The counter is incremented with ONE atomic statement, so parallel attempts cannot
 *   undercount.
 * - If the limiter's own database call fails it FAILS OPEN (and logs): a throttling
 *   outage must not lock every customer out of the store.
 * - Set RATE_LIMIT_ENABLED=false to disable (tests / local development only).
 */
export type RateLimitRule = { name: string; limit: number; windowSeconds: number };

export const RATE_LIMITS = {
  loginIp: { name: "login-ip", limit: 30, windowSeconds: 15 * 60 },
  loginAccount: { name: "login-account", limit: 8, windowSeconds: 15 * 60 },
  adminLoginIp: { name: "admin-login-ip", limit: 15, windowSeconds: 15 * 60 },
  adminLoginAccount: { name: "admin-login-account", limit: 5, windowSeconds: 15 * 60 },
  register: { name: "register-ip", limit: 10, windowSeconds: 60 * 60 },
  passwordReset: { name: "password-reset", limit: 5, windowSeconds: 60 * 60 },
  contact: { name: "contact-ip", limit: 5, windowSeconds: 60 * 60 },
  review: { name: "review-user", limit: 10, windowSeconds: 60 * 60 },
  paymentStart: { name: "payment-start-user", limit: 10, windowSeconds: 10 * 60 },
  paymentCallback: { name: "payment-callback-ip", limit: 60, windowSeconds: 60 },
  question: { name: "question-user", limit: 6, windowSeconds: 60 * 60 },
  jobApplication: { name: "job-application-ip", limit: 5, windowSeconds: 60 * 60 },
  oauthStart: { name: "oauth-ip", limit: 30, windowSeconds: 15 * 60 },
  fraudRecheck: { name: "fraud-recheck-admin", limit: 20, windowSeconds: 60 * 60 },
  // P6: manual courier-history lookups from the admin Fraud Check page (each courier asked counts once). Protects the couriers' quota from a script or a stuck button.
  courierLookupAdmin: { name: "courier-lookup-admin", limit: 90, windowSeconds: 60 * 60 },
  // Fraud Check page: a customer-risk lookup reads stored data only (no courier is called), so it is generous; it exists to stop a script enumerating phone numbers.
  riskLookupAdmin: { name: "risk-lookup-admin", limit: 180, windowSeconds: 60 * 60 },
  // Fraud Check page: asking the same courier about the same phone AGAIN, past the saved result ("Refresh from the couriers"). One refresh per admin, courier and phone every 30 s.
  courierRefreshPhone: { name: "courier-refresh-phone", limit: 1, windowSeconds: 30 },
  // Withdrawing tracking consent must essentially never be refused (it is the fail-closed direction), so this is generous.
  consentWithdraw: { name: "consent-withdraw-ip", limit: 60, windowSeconds: 10 * 60 },
  // P7.3.2: admin SMTP tools. The test e-mail is the only action that makes the server send mail to an address an admin typed, so it is the tight one.
  smtpTestEmailAdmin: { name: "smtp-test-email-admin", limit: 10, windowSeconds: 60 * 60 },
  // P12-UI-02: "Send test email" from the template designer (rendered template to ONE typed address). Tighter than nothing, looser than the fixed SMTP test because designers iterate.
  templateTestEmailAdmin: { name: "template-test-email-admin", limit: 20, windowSeconds: 60 * 60 },
  smtpCheckAdmin: { name: "smtp-check-admin", limit: 30, windowSeconds: 60 * 60 },
  // Checkout abuse brakes (P4). Generous on purpose: a household or office legitimately shares one IP; the per-phone limit is the tighter one because
  // a real customer rarely places more than a couple of orders in ten minutes. Retries of the SAME checkout (idempotency key) are never counted.
  checkoutIp: { name: "checkout-ip", limit: 20, windowSeconds: 10 * 60 },
  checkoutPhone: { name: "checkout-phone", limit: 6, windowSeconds: 10 * 60 },
  // P7.2: checkout progress autosave (the browser debounces to ~1 save / 2 s while typing). Over the limit = the save is silently skipped.
  checkoutProgressIp: { name: "checkout-progress-ip", limit: 120, windowSeconds: 10 * 60 },
  checkoutProgressOwner: { name: "checkout-progress-owner", limit: 60, windowSeconds: 10 * 60 },
} as const satisfies Record<string, RateLimitRule>;

/** Start of the fixed window containing `nowMs`. Pure. */
export function windowStartFor(nowMs: number, windowSeconds: number): Date {
  const size = windowSeconds * 1000;
  return new Date(Math.floor(nowMs / size) * size);
}

/** Pure decision for a counter value that already includes the current attempt. */
export function isOverLimit(count: number, limit: number): boolean {
  return count > limit;
}

/** Seconds until the current window ends (>= 1). Pure. */
export function retryAfterSeconds(nowMs: number, windowSeconds: number): number {
  const size = windowSeconds * 1000;
  const end = Math.floor(nowMs / size) * size + size;
  return Math.max(1, Math.ceil((end - nowMs) / 1000));
}

/** Normalises an identifier so `A@x.com`, ` a@x.com ` and `a@x.com` share one counter. */
export function normalizeIdentifier(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().slice(0, 200);
}

export function bucketKey(ruleName: string, identifier: string): string {
  const pepper = process.env.AUTH_SECRET ?? "";
  return createHash("sha256").update(`${ruleName}|${normalizeIdentifier(identifier)}|${pepper}`).digest("hex");
}

function enabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED !== "false";
}

/** Best-effort client address from the proxy headers (only ever hashed, never stored). */
export async function clientAddress(): Promise<string> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || h.get("x-real-ip") || "unknown";
  } catch {
    return "unknown";
  }
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Counts one attempt against `rule` for each identifier. Returns `ok: false` as soon as
 * any identifier is over the limit. The attempt is counted even when it is refused.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  identifiers: string[],
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  if (!enabled()) return { ok: true };
  const windowStart = windowStartFor(nowMs, rule.windowSeconds);
  try {
    for (const identifier of identifiers) {
      const key = bucketKey(rule.name, identifier);
      const rows = await prisma.$queryRaw<{ count: number }[]>`
        INSERT INTO "RateLimitBucket" ("key", "windowStart", "count")
        VALUES (${key}, ${windowStart}, 1)
        ON CONFLICT ("key", "windowStart")
        DO UPDATE SET "count" = "RateLimitBucket"."count" + 1
        RETURNING "count"`;
      if (isOverLimit(Number(rows[0]?.count ?? 0), rule.limit)) {
        return { ok: false, retryAfterSeconds: retryAfterSeconds(nowMs, rule.windowSeconds) };
      }
    }
    // Opportunistic cleanup (≈1% of calls) keeps the table small without a scheduler.
    if (Math.random() < 0.01) {
      await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(nowMs - 24 * 3600 * 1000) } } });
    }
    return { ok: true };
  } catch (error) {
    logServerError("rate_limit.failed_open", error);
    return { ok: true };
  }
}

export function throttledMessage(result: { retryAfterSeconds: number }): string {
  const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
  return `Too many attempts. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
