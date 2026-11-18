import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isValidConsentRef } from "@/lib/analytics/consent-ref";

/**
 * Consent withdrawal for server-side tracking.
 *
 * Finds the affected orders by (a) the opaque consent reference from this browser's cookie and/or (b) the signed-in customer's account,
 * then, for those orders only:
 *   1. marks the attribution snapshot withdrawn (consentState DENIED + consentWithdrawnAt) and ERASES what it held for marketing: touches,
 *      fbc/fbp, IP, user agent, GA client/session id, and the reference itself;
 *   2. turns every event that has NOT been delivered (PENDING / FAILED) into SKIPPED `consent_withdrawn`, so neither the retry job nor an
 *      admin "Retry" can send it. A row being sent right now (SENDING) is left to its worker, which re-checks consent just before the request.
 *
 * It never reads or writes orders, payments, customers or any business record. Events that were ALREADY SENT stay SENT: neither the Meta
 * Conversions API nor the GA4 Measurement Protocol offers a way to recall a delivered event, and this code does not pretend otherwise.
 * Idempotent: running it twice changes nothing the second time. Returns counts only (no ids), so a caller learns nothing about orders.
 */
export async function withdrawTrackingConsent(
  input: { consentRef?: string | null; userId?: string | null },
  opts: { now?: Date; db?: typeof prisma } = {},
): Promise<{ attributionsCleared: number; eventsSkipped: number }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const matchers: Record<string, unknown>[] = [];
  if (isValidConsentRef(input.consentRef)) matchers.push({ consentRef: input.consentRef });
  if (input.userId) matchers.push({ userId: input.userId });
  if (matchers.length === 0) return { attributionsCleared: 0, eventsSkipped: 0 };

  const affected = await db.orderAttribution.findMany({ where: { OR: matchers }, select: { orderId: true } });
  if (affected.length === 0) return { attributionsCleared: 0, eventsSkipped: 0 };
  const orderIds = affected.map((a) => a.orderId);

  // Events first: if anything below fails, no undelivered event can be sent for these orders in the meantime.
  const skipped = await db.trackingEventLog.updateMany({
    where: { orderId: { in: orderIds }, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "SKIPPED", skipReason: "consent_withdrawn", nextAttemptAt: null, updatedAt: now },
  });
  const cleared = await db.orderAttribution.updateMany({
    where: { orderId: { in: orderIds } },
    data: {
      consentState: "DENIED",
      consentWithdrawnAt: now,
      contactScrubbedAt: now,
      firstTouch: Prisma.DbNull,
      lastTouch: Prisma.DbNull,
      fbc: null, fbp: null, clientIp: null, clientUserAgent: null, gaClientId: null, gaSessionId: null, consentRef: null,
    },
  });
  return { attributionsCleared: cleared.count, eventsSkipped: skipped.count };
}
