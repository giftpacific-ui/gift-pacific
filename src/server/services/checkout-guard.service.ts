import "server-only";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { normalizeBdPhone, normalizeEmailForRisk, normalizeIp } from "@/lib/fraud/identity";
import { getFraudPolicy } from "@/server/services/fraud-risk.service";
import { matchRiskLists } from "@/server/services/risk-list.service";

/**
 * Checkout-time protections that sit around (never inside) the order transaction.
 *
 * Idempotency: the browser sends one random `checkoutKey` per checkout ATTEMPT. The order stores it in a UNIQUE column, so a double click, a retry after a
 * lost response, or two concurrent requests can never create two orders (the loser either fails the cart claim in placeOrder or hits the unique index,
 * and then gets the winner's result here). Two separate orders use two different keys and are never merged. A key only "proves" a replay when the owner
 * (signed-in account, or guest) and the phone number also match, and only within IDEMPOTENCY_WINDOW_MS.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

export type CheckoutReplay =
  | { kind: "replay"; orderNumber: string; confirmationToken: string | null }
  | { kind: "mismatch" }
  | null;

export async function findCheckoutReplay(
  key: string | null | undefined,
  who: { userId: string | null; phone: string },
  now: Date = new Date(),
): Promise<CheckoutReplay> {
  if (!key) return null;
  const o = await prisma.order.findUnique({
    where: { checkoutKey: key },
    select: { orderNumber: true, confirmationToken: true, userId: true, phoneNorm: true, createdAt: true },
  });
  if (!o) return null;
  const phone = normalizeBdPhone(who.phone);
  const sameOwner = (o.userId ?? null) === (who.userId ?? null);
  const fresh = now.getTime() - o.createdAt.getTime() <= IDEMPOTENCY_WINDOW_MS;
  // Same key but a different owner/phone/age is NOT the same submission: refuse to hand over someone else's order.
  if (!sameOwner || !fresh || !phone || o.phoneNorm !== phone) return { kind: "mismatch" };
  return { kind: "replay", orderNumber: o.orderNumber, confirmationToken: o.confirmationToken ?? null };
}

/**
 * Only when the admin policy says blockAction = REJECT (and mode ENFORCE): is this phone or e-mail on the ACTIVE block list? IP blocks never reject (shared
 * networks), and by default (HOLD) nothing is refused here at all: the order is accepted and held for manual review by the risk engine instead.
 */
export async function shouldRejectAtCheckout(input: { phone: string; email: string; ip: string | null }): Promise<boolean> {
  const { policy } = await getFraudPolicy();
  if (policy.mode !== "ENFORCE" || policy.blockAction !== "REJECT") return false;
  const phone = normalizeBdPhone(input.phone);
  const m = await matchRiskLists({ phones: phone ? [phone] : [], email: normalizeEmailForRisk(input.email), ip: normalizeIp(input.ip) });
  return m.blocked.phone || m.blocked.email;
}

/** Looks a key up after a failed placement (cart claim lost / unique violation): if a winner exists, its result is returned. */
export async function resolveLostRace(key: string | null | undefined, who: { userId: string | null; phone: string }): Promise<CheckoutReplay> {
  return findCheckoutReplay(key, who);
}

export { WEBSITE_CHANNEL_ID };
