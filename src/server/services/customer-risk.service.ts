import "server-only";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { normalizeBdPhone, normalizeEmailForRisk, orderIdentity } from "@/lib/fraud/identity";
import { computeCustomerStats, type CustomerStats } from "@/lib/fraud/customer-stats";
import { SIGNAL_LABELS, type RiskLevel, type SignalCode } from "@/lib/fraud/policy";
import { matchRiskLists } from "@/server/services/risk-list.service";

/**
 * Admin-only customer risk profile. A "customer" is whatever the matching identifiers say: guests are covered by their normalised phone / e-mail,
 * signed-in customers also by their account. It is built from real orders, assessments, reviews and list entries; nothing is cached or invented.
 * It is NEVER returned to a customer (it is only reachable from admin-guarded pages and actions).
 */
export const PROFILE_ORDER_LIMIT = 500;

export type CustomerRiskProfile = {
  identity: { phones: string[]; email: string | null; userId: string | null };
  stats: CustomerStats;
  currentRisk: { orderNumber: string; score: number; level: RiskLevel; assessedAt: Date | null } | null;
  scoreHistory: { orderNumber: string; score: number; level: RiskLevel; trigger: string; at: Date }[];
  signals: { code: string; label: string; orders: number }[];
  activeListEntries: { id: string; listType: string; kind: string; reason: string; expiresAt: Date | null }[];
  recentOrders: { orderNumber: string; createdAt: Date; status: string; total: number; riskLevel: RiskLevel | null; riskScore: number | null }[];
  truncated: boolean;
};

export async function getCustomerRiskProfile(
  who: { orderId?: string; phone?: string; email?: string; userId?: string },
  opts: { now?: Date } = {},
): Promise<CustomerRiskProfile | null> {
  const now = opts.now ?? new Date();
  let phones: string[] = [];
  let email: string | null = null;
  let userId: string | null = who.userId ?? null;
  if (who.orderId) {
    const o = await prisma.order.findUnique({ where: { id: who.orderId }, select: { phone: true, email: true, userId: true, shippingSnapshot: true } });
    if (!o) return null;
    const id = orderIdentity(o);
    phones = id.phones; email = id.emailNorm; userId = userId ?? o.userId;
  }
  const p = normalizeBdPhone(who.phone);
  if (p) phones = [...new Set([...phones, p])];
  const e = normalizeEmailForRisk(who.email);
  if (e) email = email ?? e;
  const identity: Record<string, unknown>[] = [];
  if (phones.length) identity.push({ phoneNorm: { in: phones } });
  if (email) identity.push({ emailNorm: email });
  if (userId) identity.push({ userId });
  if (identity.length === 0) return null;

  const orders = await prisma.order.findMany({
    where: { channelId: WEBSITE_CHANNEL_ID, OR: identity },
    select: {
      id: true, orderNumber: true, createdAt: true, status: true, total: true, riskLevel: true, riskScore: true, riskAssessedAt: true,
      riskReviewDecision: true, riskReviewedLevel: true, trackingEvents: { select: { status: true } },
    },
    orderBy: { createdAt: "desc" },
    take: PROFILE_ORDER_LIMIT,
  });

  const stats = computeCustomerStats(
    orders.map((o) => ({
      status: o.status, total: Number(o.total), riskLevel: o.riskLevel, riskReviewDecision: o.riskReviewDecision, riskReviewedLevel: o.riskReviewedLevel,
      events: o.trackingEvents.map((t) => t.status),
    })),
  );
  const latest = orders.find((o) => o.riskScore != null && o.riskLevel);
  const ids = orders.map((o) => o.id);
  const numberOf = new Map(orders.map((o) => [o.id, o.orderNumber]));
  const assessments = ids.length
    ? await prisma.orderRiskAssessment.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, score: true, level: true, trigger: true, signals: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100 })
    : [];

  // Which signals recur across this customer's orders: counted over each order's LATEST assessment only.
  const seen = new Set<string>();
  const signalOrders = new Map<string, number>();
  for (const a of assessments) {
    if (seen.has(a.orderId)) continue;
    seen.add(a.orderId);
    for (const s of ((a.signals as { signals?: { code: string; points: number }[] } | null)?.signals ?? [])) {
      if (s.points > 0) signalOrders.set(s.code, (signalOrders.get(s.code) ?? 0) + 1);
    }
  }
  const lists = await matchRiskLists({ phones, email, ip: null }, { now });
  const entries = lists.entryIds.length ? await prisma.riskListEntry.findMany({ where: { id: { in: lists.entryIds } }, select: { id: true, listType: true, kind: true, reason: true, expiresAt: true } }) : [];

  return {
    identity: { phones, email, userId },
    stats,
    currentRisk: latest ? { orderNumber: latest.orderNumber, score: latest.riskScore as number, level: latest.riskLevel as RiskLevel, assessedAt: latest.riskAssessedAt } : null,
    scoreHistory: assessments.slice(0, 25).map((a) => ({ orderNumber: numberOf.get(a.orderId) ?? "", score: a.score, level: a.level as RiskLevel, trigger: a.trigger, at: a.createdAt })),
    signals: [...signalOrders].map(([code, n]) => ({ code, label: SIGNAL_LABELS[code as SignalCode] ?? code, orders: n })).sort((x, y) => y.orders - x.orders),
    activeListEntries: entries,
    recentOrders: orders.slice(0, 20).map((o) => ({ orderNumber: o.orderNumber, createdAt: o.createdAt, status: o.status, total: Number(o.total), riskLevel: o.riskLevel as RiskLevel | null, riskScore: o.riskScore })),
    truncated: orders.length >= PROFILE_ORDER_LIMIT,
  };
}
