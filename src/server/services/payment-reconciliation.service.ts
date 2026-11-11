import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/** Pending claims older than this are "stale": the customer is waiting for a decision. */
export const STALE_CLAIM_HOURS = 48;
const LIMIT = 100;

/**
 * Read-only checks over the EXISTING payment records (manual advance claims and anything recorded with a provider
 * reference). It changes nothing. Provider-confirmed amounts are not compared because no online gateway is connected
 * (see lib/payments/provider.ts); the local verified amounts are compared with each order's own totals instead.
 */
export async function getPaymentReconciliation() {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_HOURS * 3600_000);

  const [stale, duplicates, mismatched, unreferenced, recentRejected] = await Promise.all([
    // Claims still waiting for a staff decision.
    prisma.payment.findMany({
      where: { status: "PENDING", kind: "ADVANCE", createdAt: { lt: staleBefore } },
      orderBy: { createdAt: "asc" },
      take: LIMIT,
      select: { id: true, method: true, amount: true, customerReference: true, createdAt: true, order: { select: { id: true, orderNumber: true } } },
    }),
    // The same wallet reference claimed more than once (any order): a replay or a mistyped reference.
    prisma.$queryRaw<{ method: string; reference: string; claims: number; orders: string[] }[]>(Prisma.sql`
      SELECT p."method"::text AS "method", UPPER(TRIM(p."customerReference")) AS "reference", COUNT(*)::int AS "claims",
             ARRAY_AGG(DISTINCT o."orderNumber") AS "orders"
      FROM "Payment" p JOIN "Order" o ON o."id" = p."orderId"
      WHERE p."customerReference" IS NOT NULL AND TRIM(p."customerReference") <> ''
      GROUP BY p."method", UPPER(TRIM(p."customerReference"))
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT ${LIMIT}`),
    // Verified advance payments that do not add up to what the order says was paid (or exceed the order total).
    prisma.$queryRaw<{ id: string; orderNumber: string; total: string; advancePaid: string; verified: string }[]>(Prisma.sql`
      SELECT o."id", o."orderNumber", o."total"::text AS "total", o."advancePaid"::text AS "advancePaid",
             COALESCE(SUM(p."amount") FILTER (WHERE p."status" = 'PAID' AND p."kind" = 'ADVANCE'), 0)::text AS "verified"
      FROM "Order" o LEFT JOIN "Payment" p ON p."orderId" = o."id"
      GROUP BY o."id"
      HAVING o."advancePaid" <> COALESCE(SUM(p."amount") FILTER (WHERE p."status" = 'PAID' AND p."kind" = 'ADVANCE'), 0)
          OR o."advancePaid" > o."total"
      ORDER BY o."createdAt" DESC
      LIMIT ${LIMIT}`),
    // Verified payments with no provider reference cannot be matched against a wallet statement.
    prisma.payment.findMany({
      where: { status: "PAID", providerRef: null, method: { not: "COD" } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, method: true, amount: true, createdAt: true, order: { select: { id: true, orderNumber: true } } },
    }),
    prisma.payment.findMany({
      where: { status: "FAILED", kind: "ADVANCE" },
      orderBy: { verifiedAt: "desc" },
      take: 20,
      select: { id: true, method: true, amount: true, customerReference: true, verifiedAt: true, order: { select: { id: true, orderNumber: true } } },
    }),
  ]);

  return { stale, duplicates, mismatched, unreferenced, recentRejected };
}

/**
 * Online gateway transactions, separated by what actually happened at the provider. Read-only.
 * "Unmatched provider transactions" (money at bKash with no local attempt) cannot be found from here: that needs a bKash
 * statement or the transaction-search API run per id, so it is not claimed.
 */
export async function getGatewayReconciliation() {
  const now = new Date();
  const [byStatus, needsReview, stuck, mismatched, refunds, recent, refundableRaw, refundsNoAccounting, pendingRefunds] = await Promise.all([
    prisma.gatewayTransaction.groupBy({ by: ["status"], _count: { _all: true }, _sum: { amount: true } }),
    prisma.gatewayTransaction.findMany({
      where: { status: "NEEDS_REVIEW" },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, amount: true, providerPaymentId: true, providerTrxId: true, failureReason: true, updatedAt: true, order: { select: { id: true, orderNumber: true } } },
    }),
    // Open attempts past their time limit: re-check them with the provider.
    prisma.gatewayTransaction.findMany({
      where: { OR: [{ status: { in: ["PENDING_APPROVAL", "VERIFYING"] }, expiresAt: { lt: now } }, { status: "INITIATED", createdAt: { lt: new Date(now.getTime() - 2 * 60 * 1000) } }] },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, amount: true, status: true, createdAt: true, order: { select: { id: true, orderNumber: true } } },
    }),
    // Confirmed by the provider, but the local payment amount differs from what the provider confirmed.
    prisma.gatewayTransaction.findMany({
      where: { status: "SUCCEEDED", payment: { isNot: null } },
      orderBy: { verifiedAt: "desc" },
      take: 200,
      select: { id: true, amount: true, providerTrxId: true, payment: { select: { amount: true } }, order: { select: { id: true, orderNumber: true } } },
    }),
    prisma.gatewayRefund.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, amount: true, status: true, reason: true, providerRefundTrxId: true, createdAt: true, transaction: { select: { id: true, order: { select: { id: true, orderNumber: true } } } } },
    }),
    prisma.gatewayTransaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, provider: true, status: true, amount: true, providerTrxId: true, failureReason: true, createdAt: true, order: { select: { id: true, orderNumber: true } } },
    }),
    // Confirmed payments on orders where a refund is legitimate under the existing rules (cancelled / refund requested / refunded).
    prisma.gatewayTransaction.findMany({
      where: { status: "SUCCEEDED", provider: "BKASH", order: { status: { in: ["REFUND_REQUESTED", "REFUNDED", "CANCELLED"] } } },
      orderBy: { verifiedAt: "desc" },
      take: 30,
      select: { id: true, amount: true, order: { select: { id: true, orderNumber: true, status: true } }, refunds: { select: { amount: true, status: true } } },
    }),
    // Refunds bKash confirmed that are not yet in the refund accounting.
    prisma.gatewayRefund.findMany({
      where: { status: "SUCCEEDED", incidentId: null },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, amount: true, providerRefundTrxId: true, transaction: { select: { order: { select: { id: true, orderNumber: true } } } } },
    }),
    // Refunds still PENDING: split below into "never sent" and "may have reached bKash".
    prisma.gatewayRefund.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, amount: true, reason: true, createdAt: true, submittedAt: true, providerStatus: true, proposedOutcome: true, proposedById: true, proposedAt: true, proposedEvidence: true, proposedNote: true, proposedTrxId: true, transaction: { select: { order: { select: { id: true, orderNumber: true } } } } },
    }),
  ]);
  const refundsNeverSent = pendingRefunds.filter((r) => !r.submittedAt);
  const refundsUncertain = pendingRefunds.filter((r) => r.submittedAt);
  const refundable = refundableRaw
    .map((t) => ({ ...t, remaining: (Math.round(Number(t.amount) * 100) - t.refunds.filter((r) => r.status !== "FAILED").reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0)) / 100 }))
    .filter((t) => t.remaining > 0);
  return {
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, amount: Number(s._sum.amount ?? 0) })),
    needsReview,
    stuck,
    mismatched: mismatched.filter((t) => t.payment && Math.round(Number(t.payment.amount) * 100) !== Math.round(Number(t.amount) * 100)),
    refunds,
    recent,
    refundable,
    refundsNoAccounting,
    refundsNeverSent,
    refundsUncertain,
  };
}
