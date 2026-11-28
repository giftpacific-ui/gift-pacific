import "server-only";
import type { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { maskEmail, maskPhone } from "@/lib/fraud/customer-stats";
import { normalizeBdPhone } from "@/lib/fraud/identity";
import { RISK_LEVELS, type RiskLevel } from "@/lib/fraud/policy";

/**
 * Review queue and reports. Everything is computed from real rows: counts use `count`, the rest read a BOUNDED, narrow selection (REPORT_ROW_LIMIT)
 * and aggregate it; if a window holds more rows than that, `truncated` is true and the UI says so rather than presenting partial numbers as complete.
 * Phone numbers and e-mails are masked in report tables (admins open the orders for detail).
 */
export const REPORT_ROW_LIMIT = 5000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------- pure helpers
export function bucketByDay(rows: { createdAt: Date; riskLevel: string | null }[], from: Date, to: Date): { date: string; high: number; critical: number }[] {
  const days = new Map<string, { high: number; critical: number }>();
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += DAY) days.set(new Date(t).toISOString().slice(0, 10), { high: 0, critical: 0 });
  for (const r of rows) {
    const d = days.get(r.createdAt.toISOString().slice(0, 10));
    if (!d) continue;
    if (r.riskLevel === "CRITICAL") d.critical += 1;
    else if (r.riskLevel === "HIGH") d.high += 1;
  }
  return [...days].map(([date, v]) => ({ date, ...v }));
}

/** Keys that appear at least `min` times, with the order numbers behind each (max 6), most frequent first. */
export function repeatGroups(rows: { key: string | null; orderNumber: string }[], min: number): { key: string; count: number; orderNumbers: string[] }[] {
  const g = new Map<string, string[]>();
  for (const r of rows) if (r.key && r.key !== "-") g.set(r.key, [...(g.get(r.key) ?? []), r.orderNumber]);
  return [...g].filter(([, v]) => v.length >= min).map(([key, v]) => ({ key, count: v.length, orderNumbers: v.slice(0, 6) })).sort((a, b) => b.count - a.count).slice(0, 25);
}

// ---------------------------------------------------------------------------------------------------------------- review queue
export type QueueFilters = { levels?: RiskLevel[]; state?: "pending" | "reviewed" | "all"; search?: string; take?: number; skip?: number };

export async function getReviewQueue(f: QueueFilters = {}) {
  const levels = (f.levels?.length ? f.levels : ["HIGH", "CRITICAL"]).filter((l) => (RISK_LEVELS as readonly string[]).includes(l));
  const where: Record<string, unknown> = { channelId: WEBSITE_CHANNEL_ID, riskLevel: { in: levels } };
  if (f.state === "reviewed") where.riskReviewedAt = { not: null };
  else if (f.state !== "all") Object.assign(where, { riskReviewRequired: true, riskReviewedAt: null, status: { in: ["PENDING", "CONFIRMED", "PROCESSING"] } });
  const q = f.search?.trim();
  if (q) {
    const phone = normalizeBdPhone(q);
    where.OR = [{ orderNumber: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, ...(phone ? [{ phoneNorm: phone }] : [{ phone: { contains: q } }])];
  }
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where, orderBy: [{ riskScore: "desc" }, { createdAt: "desc" }], take: Math.min(f.take ?? 50, 100), skip: f.skip ?? 0,
      select: { id: true, orderNumber: true, createdAt: true, status: true, total: true, phone: true, email: true, riskScore: true, riskLevel: true, riskAssessedAt: true, riskReviewRequired: true, riskReviewDecision: true, riskReviewedAt: true },
    }),
    prisma.order.count({ where }),
  ]);
  return { rows: rows.map((r) => ({ ...r, total: Number(r.total) })), total };
}

export async function getQueueCounts() {
  const base = { channelId: WEBSITE_CHANNEL_ID, riskReviewRequired: true, riskReviewedAt: null, status: { in: ["PENDING", "CONFIRMED", "PROCESSING"] as OrderStatus[] } };
  const [high, critical] = await Promise.all([prisma.order.count({ where: { ...base, riskLevel: "HIGH" } }), prisma.order.count({ where: { ...base, riskLevel: "CRITICAL" } })]);
  return { high, critical, total: high + critical };
}

// ---------------------------------------------------------------------------------------------------------------- reports
export type RiskReports = {
  range: { from: Date; to: Date };
  byLevel: Record<RiskLevel | "UNASSESSED", number>;
  trend: { date: string; high: number; critical: number }[];
  repeatCancellations: { phone: string; count: number; orderNumbers: string[] }[];
  failedDeliveryPatterns: { phone: string; count: number; orderNumbers: string[] }[];
  repeatedActivity: { phones: { phone: string; count: number; orderNumbers: string[] }[]; emails: { email: string; count: number; orderNumbers: string[] }[]; ips: { ip: string; count: number; orderNumbers: string[] }[] };
  reviewOutcomes: { approved: number; rejected: number; pending: number };
  /** Approved reviews of HIGH/CRITICAL orders (admin overrides) and how those orders turned out. */
  overrides: { total: number; delivered: number; failedDelivery: number; cancelled: number; inProgress: number; deliveredShare: number | null };
  truncated: boolean;
  notes: string[];
};

export async function getRiskReports(range: { from: Date; to: Date }): Promise<RiskReports> {
  const { from, to } = range;
  const created = { gte: from, lte: to };
  const site = { channelId: WEBSITE_CHANNEL_ID };
  const [low, medium, high, critical, unassessed] = await Promise.all([
    ...(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).map((riskLevel) => prisma.order.count({ where: { ...site, createdAt: created, riskLevel } })),
    prisma.order.count({ where: { ...site, createdAt: created, riskLevel: null } }),
  ]);

  const [riskyRows, cancelledRows, failedEvents, identityRows, ipRows, reviewed, pending] = await Promise.all([
    prisma.order.findMany({ where: { ...site, createdAt: created, riskLevel: { in: ["HIGH", "CRITICAL"] } }, select: { createdAt: true, riskLevel: true }, take: REPORT_ROW_LIMIT }),
    prisma.order.findMany({ where: { ...site, createdAt: created, status: "CANCELLED" }, select: { orderNumber: true, phoneNorm: true }, take: REPORT_ROW_LIMIT }),
    prisma.orderTrackingEvent.findMany({ where: { status: "FAILED_DELIVERY", createdAt: created }, select: { order: { select: { orderNumber: true, phoneNorm: true, channelId: true } } }, take: REPORT_ROW_LIMIT }),
    prisma.order.findMany({ where: { ...site, createdAt: created }, select: { orderNumber: true, phoneNorm: true, emailNorm: true }, take: REPORT_ROW_LIMIT }),
    prisma.orderRiskAssessment.findMany({ where: { createdAt: created, clientIp: { not: null } }, select: { clientIp: true, order: { select: { orderNumber: true } } }, take: REPORT_ROW_LIMIT }),
    prisma.order.findMany({ where: { ...site, riskReviewedAt: { gte: from, lte: to } }, select: { riskReviewDecision: true, riskReviewedLevel: true, status: true, trackingEvents: { select: { status: true } } }, take: REPORT_ROW_LIMIT }),
    prisma.order.count({ where: { ...site, riskReviewRequired: true, riskReviewedAt: null, status: { in: ["PENDING", "CONFIRMED", "PROCESSING"] } } }),
  ]);

  const truncated = [riskyRows, cancelledRows, failedEvents, identityRows, ipRows, reviewed].some((r) => r.length >= REPORT_ROW_LIMIT);
  const failed = failedEvents.filter((e) => e.order?.channelId === WEBSITE_CHANNEL_ID).map((e) => ({ key: e.order?.phoneNorm ?? null, orderNumber: e.order?.orderNumber ?? "" }));
  const ipGroups = repeatGroups(ipRows.map((r) => ({ key: r.clientIp, orderNumber: r.order?.orderNumber ?? "" })), 3);

  const overridden = reviewed.filter((r) => r.riskReviewDecision === "APPROVED" && (r.riskReviewedLevel === "HIGH" || r.riskReviewedLevel === "CRITICAL"));
  const has = (r: (typeof overridden)[number], s: string) => r.trackingEvents.some((t) => t.status === s);
  const delivered = overridden.filter((r) => has(r, "DELIVERED")).length;
  const failedDelivery = overridden.filter((r) => !has(r, "DELIVERED") && has(r, "FAILED_DELIVERY")).length;
  const cancelled = overridden.filter((r) => r.status === "CANCELLED").length;
  const inProgress = overridden.length - delivered - failedDelivery - cancelled;

  return {
    range,
    byLevel: { LOW: low, MEDIUM: medium, HIGH: high, CRITICAL: critical, UNASSESSED: unassessed },
    trend: bucketByDay(riskyRows, from, to),
    repeatCancellations: repeatGroups(cancelledRows.map((r) => ({ key: r.phoneNorm, orderNumber: r.orderNumber })), 2).map((g) => ({ phone: maskPhone(g.key), count: g.count, orderNumbers: g.orderNumbers })),
    failedDeliveryPatterns: repeatGroups(failed, 2).map((g) => ({ phone: maskPhone(g.key), count: g.count, orderNumbers: g.orderNumbers })),
    repeatedActivity: {
      phones: repeatGroups(identityRows.map((r) => ({ key: r.phoneNorm, orderNumber: r.orderNumber })), 3).map((g) => ({ phone: maskPhone(g.key), count: g.count, orderNumbers: g.orderNumbers })),
      emails: repeatGroups(identityRows.map((r) => ({ key: r.emailNorm, orderNumber: r.orderNumber })), 3).map((g) => ({ email: maskEmail(g.key), count: g.count, orderNumbers: g.orderNumbers })),
      ips: ipGroups.map((g) => ({ ip: g.key, count: g.count, orderNumbers: g.orderNumbers })),
    },
    reviewOutcomes: { approved: reviewed.filter((r) => r.riskReviewDecision === "APPROVED").length, rejected: reviewed.filter((r) => r.riskReviewDecision === "REJECTED").length, pending },
    overrides: { total: overridden.length, delivered, failedDelivery, cancelled, inProgress, deliveredShare: overridden.length ? Math.round((delivered / overridden.length) * 1000) / 1000 : null },
    truncated,
    notes: [
      "An override is an admin approving a HIGH/CRITICAL order. 'Delivered' overrides are the closest recorded evidence of a false positive; 'failed delivery' overrides suggest the risk was real. Neither is proof: the system records outcomes, not intent.",
      "IP-based figures only cover assessments still inside the IP retention period, and a shared network address is not one customer.",
      "Refused COD orders are not recorded separately; failed deliveries are the nearest recorded outcome.",
    ],
  };
}
