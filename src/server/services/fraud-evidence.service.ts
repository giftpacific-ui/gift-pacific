import "server-only";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { addressSuspicion, emptyEvidence, type RiskEvidence } from "@/lib/fraud/scoring";
import type { FraudPolicy } from "@/lib/fraud/policy";
import { matchRiskLists } from "@/server/services/risk-list.service";

/**
 * Reads the REAL records behind each risk signal. Every query is bounded (`take`) and uses an indexed identity key (phoneNorm / emailNorm /
 * addressKey / userId / the assessment's IP), so evaluating an order stays cheap however large the order table grows. Nothing here is inferred or
 * estimated: a signal whose data is missing (no IP, no address key, no courier evidence) simply contributes nothing.
 *
 * "The same customer" is: same normalised phone, OR same normalised e-mail, OR same signed-in account. A shared IP is never treated as one customer.
 */
type Db = typeof prisma;

export type EvaluatedOrder = {
  id: string; orderNumber: string; userId: string | null; total: number; createdAt: Date;
  phones: string[]; emailNorm: string | null; addressKey: string | null;
  trustScore: number | null; trustSnapshot: unknown; shippingSnapshot: unknown;
  items: { productId: string; variantId: string | null; quantity: number }[];
};

export const HISTORY_SCAN_LIMIT = 200;
const MS = { hour: 3_600_000, minute: 60_000, day: 86_400_000 };

const cartSignature = (items: { productId: string; variantId: string | null; quantity: number }[]) =>
  items.map((i) => `${i.productId}:${i.variantId ?? ""}:${i.quantity}`).sort().join("|");

type PriorOrder = {
  id: string; orderNumber: string; status: string; createdAt: Date; phoneNorm: string | null; emailNorm: string | null; addressKey: string | null;
  riskReviewDecision: string | null; items: { productId: string; variantId: string | null; quantity: number }[]; trackingEvents: { status: string }[];
};

export async function gatherRiskEvidence(
  db: Db,
  o: EvaluatedOrder,
  ctx: { ip: string | null; policy: FraudPolicy; now: Date },
): Promise<{ evidence: RiskEvidence; meta: Record<string, unknown> }> {
  const { policy, now } = ctx;
  const e = emptyEvidence();
  const w = policy.windows;
  const meta: Record<string, unknown> = { phonesChecked: o.phones.length, hasEmail: Boolean(o.emailNorm), hasAddressKey: Boolean(o.addressKey), hasIp: Boolean(ctx.ip) };

  // ---- the same customer's other website orders
  const identity: Record<string, unknown>[] = [];
  if (o.phones.length) identity.push({ phoneNorm: { in: o.phones } });
  if (o.emailNorm) identity.push({ emailNorm: o.emailNorm });
  if (o.userId) identity.push({ userId: o.userId });
  const prior: PriorOrder[] = identity.length
    ? ((await db.order.findMany({
        where: { id: { not: o.id }, channelId: WEBSITE_CHANNEL_ID, OR: identity },
        select: {
          id: true, orderNumber: true, status: true, createdAt: true, phoneNorm: true, emailNorm: true, addressKey: true, riskReviewDecision: true,
          items: { select: { productId: true, variantId: true, quantity: true } },
          trackingEvents: { select: { status: true } },
        },
        orderBy: { createdAt: "desc" },
        take: HISTORY_SCAN_LIMIT,
      })) as unknown as PriorOrder[])
    : [];
  meta.historyScanned = prior.length;
  meta.historyTruncated = prior.length >= HISTORY_SCAN_LIMIT;

  const everHad = (p: PriorOrder, s: string) => p.trackingEvents.some((t) => t.status === s);
  const ref = (list: PriorOrder[]) => list.map((p) => p.orderNumber).slice(0, 5);
  const rejected = prior.filter((p) => p.riskReviewDecision === "REJECTED");
  // A fraud rejection also ends as CANCELLED: it is counted once, as a rejection, never again as a plain cancellation.
  const cancelled = prior.filter((p) => p.status === "CANCELLED" && p.riskReviewDecision !== "REJECTED");
  const failed = prior.filter((p) => everHad(p, "FAILED_DELIVERY"));
  const delivered = prior.filter((p) => everHad(p, "DELIVERED"));
  e.history = {
    cancelled: cancelled.length, failedDelivery: failed.length, fraudRejected: rejected.length, delivered: delivered.length,
    refs: { cancelled: ref(cancelled), failedDelivery: ref(failed), fraudRejected: ref(rejected) },
  };

  // ---- frequency (symmetric around this order, so re-evaluating an older order sees the same neighbours)
  const near = (p: PriorOrder, ms: number) => Math.abs(p.createdAt.getTime() - o.createdAt.getTime()) <= ms;
  const byPhone = prior.filter((p) => p.phoneNorm !== null && o.phones.includes(p.phoneNorm));
  const burst = byPhone.filter((p) => near(p, w.burstHours * MS.hour));
  e.burst = { count: burst.length, refs: ref(burst) };
  const signature = cartSignature(o.items);
  const dupes = prior.filter((p) => near(p, w.duplicateMinutes * MS.minute) && p.items.length > 0 && cartSignature(p.items) === signature);
  e.duplicate = { count: dupes.length, refs: ref(dupes) };

  // ---- identifiers shared with OTHER phone numbers
  const since = (days: number) => new Date(now.getTime() - days * MS.day);
  if (o.addressKey) {
    const sameAddress = await db.order.findMany({
      where: { id: { not: o.id }, channelId: WEBSITE_CHANNEL_ID, addressKey: o.addressKey, createdAt: { gte: since(w.addressDays) }, phoneNorm: { notIn: o.phones.length ? o.phones : ["-"] } },
      select: { phoneNorm: true }, take: 100,
    });
    e.address.distinctOtherPhones = new Set(sameAddress.map((r) => r.phoneNorm).filter((p): p is string => Boolean(p) && p !== "-")).size;
    e.address.knownDeliveredAddress = delivered.some((p) => p.addressKey === o.addressKey && p.phoneNorm !== null && o.phones.includes(p.phoneNorm));
  }
  if (o.emailNorm) {
    const sameEmail = await db.order.findMany({
      where: { id: { not: o.id }, channelId: WEBSITE_CHANNEL_ID, emailNorm: o.emailNorm, createdAt: { gte: since(w.emailDays) }, phoneNorm: { notIn: o.phones.length ? o.phones : ["-"] } },
      select: { phoneNorm: true }, take: 100,
    });
    e.email.distinctOtherPhones = new Set(sameEmail.map((r) => r.phoneNorm).filter((p): p is string => Boolean(p) && p !== "-")).size;
  }
  if (ctx.ip) {
    const sameIp = await db.orderRiskAssessment.findMany({
      where: { clientIp: ctx.ip, orderId: { not: o.id }, createdAt: { gte: new Date(now.getTime() - w.ipHours * MS.hour) } },
      select: { order: { select: { phoneNorm: true } } }, take: 200,
    });
    const phones = new Set(sameIp.map((r) => r.order?.phoneNorm).filter((p): p is string => Boolean(p) && p !== "-"));
    for (const p of o.phones) phones.add(p);
    e.ip = { distinctPhones: phones.size };
  }

  // ---- advance-payment history: staff decisions already recorded by the existing verification workflow
  if (prior.length) {
    const pays = await db.payment.findMany({ where: { orderId: { in: prior.map((p) => p.id) }, kind: "ADVANCE" }, select: { status: true } });
    e.advance = { rejected: pays.filter((p) => p.status === "FAILED").length, verified: pays.filter((p) => p.status === "PAID").length };
  }

  // ---- lists
  const lists = await matchRiskLists({ phones: o.phones, email: o.emailNorm, ip: ctx.ip }, { db, now });
  e.lists = { blocked: lists.blocked, allowed: lists.allowed };
  meta.listEntries = lists.entryIds.length;

  // ---- the EXISTING trust result, read as stored with the order (never recomputed here)
  const snap = (o.trustSnapshot && typeof o.trustSnapshot === "object" ? o.trustSnapshot : {}) as { insufficientEvidence?: unknown; zone?: { conflict?: unknown }; policy?: { lowBelow?: unknown } };
  e.trust = {
    score: o.trustScore ?? null,
    insufficientEvidence: snap.insufficientEvidence !== false,
    lowBelow: typeof snap.policy?.lowBelow === "number" ? snap.policy.lowBelow : null,
    zoneConflict: snap.zone?.conflict === true,
  };

  e.order = { total: o.total };
  const ship = (o.shippingSnapshot && typeof o.shippingSnapshot === "object" ? o.shippingSnapshot : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  e.addressQuality = addressSuspicion({ fullName: s(ship.fullName), line1: s(ship.line1), line2: s(ship.line2) });
  return { evidence: e, meta };
}
