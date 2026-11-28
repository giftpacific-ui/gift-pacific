import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { consumeRateLimit, RATE_LIMITS, throttledMessage } from "@/lib/rate-limit";
import { isIntelProvider, type IntelProviderKey } from "@/lib/courier-intelligence/types";
import { buildHistoryView, type HistoryView } from "@/lib/courier-intelligence/view";
import { buildRiskView, type RiskPanelInput, type RiskView } from "@/lib/fraud/risk-view";
import { normalizeBdPhone } from "@/lib/fraud/identity";
import type { RiskLevel } from "@/lib/fraud/policy";
import { assertAdminActor, checkedPhoneOf, recordAudit, type CourierEvidence } from "@/server/services/advance.service";
import { getCustomerRiskProfile } from "@/server/services/customer-risk.service";
import { getOrderFraudPanel, type OrderFraudPanel } from "@/server/services/fraud-review.service";
import { getFraudPolicy } from "@/server/services/fraud-risk.service";
import { courierAskable, getProviderReport, getStoredIntelligence, hashPhone, maskPhone, type IntelligenceResult } from "@/server/services/courier-intelligence.service";

/**
 * Admin entry points to the courier intelligence. Every one re-checks that the actor is an ACTIVE ADMIN in the database (not only in the server
 * action), throttles manual lookups per admin, and records an audit event that carries only the MASKED phone number.
 */

/** One courier's report for any valid Bangladesh mobile number (no customer or order record is needed). */
export async function adminCheckProvider(args: { adminId: string | null | undefined; phone: string; provider: unknown; fresh: boolean }) {
  const adminId = await assertAdminActor(prisma, args.adminId);
  if (!isIntelProvider(args.provider)) throw new UserFacingError("Unknown courier.");
  const provider: IntelProviderKey = args.provider;
  // Budgets are charged only when a courier would really be contacted. An unsupported or unconfigured courier answers instantly from the registry,
  // so asking about it must not use up the admin's lookups (three couriers per click used to cost three, even when two could never be asked).
  if (courierAskable(provider)) {
    const phone = args.fresh ? normalizeBdPhone(args.phone) : null;
    if (phone) {
      // A refresh past the saved result is limited per admin, courier AND phone (keyed by a hash, never the number): a stuck button or a script cannot hammer one courier.
      const gap = await consumeRateLimit(RATE_LIMITS.courierRefreshPhone, [`${adminId}|${provider}|${hashPhone(phone)}`]);
      if (!gap.ok) throw new UserFacingError(`This courier was just refreshed for this number. Try again in ${gap.retryAfterSeconds} second${gap.retryAfterSeconds === 1 ? "" : "s"}.`);
    }
    const throttle = await consumeRateLimit(RATE_LIMITS.courierLookupAdmin, [adminId]);
    if (!throttle.ok) throw new UserFacingError(throttledMessage(throttle));
  }
  const r = await getProviderReport(args.phone, provider, { fresh: args.fresh, source: "ADMIN" });
  if (r.phoneValid) {
    await recordAudit(prisma, {
      actorId: adminId, action: "COURIER_INTEL_LOOKUP", entityType: "COURIER_INTELLIGENCE",
      detail: { phoneMasked: r.phoneMasked, provider, fresh: args.fresh, status: r.report.status, reason: r.report.reason, cached: r.report.cached },
    });
  }
  return r;
}

export type OrderIntelligencePanel = {
  /** The phone the lookup is about (the delivery phone in the order's shipping snapshot), masked. */
  phoneMasked: string | null;
  /** A. External courier history: what is stored now (no courier is called by opening the page). */
  stored: IntelligenceResult | null;
  unchecked: IntelProviderKey[];
  /** The evidence frozen with the order at checkout (never rewritten). */
  atCheckout: CourierEvidence | null;
  /** Earlier manual rechecks, newest last (each a stored, timestamped result). */
  rechecks: { at: string; byId: string; rate: number | null; tier: string | null; status: string; providers: string | null }[];
  /** B. Internal Gift Pacific order history: this website's orders only, NOT courier history. */
  internal: { total: number; delivered: number; cancelled: number; failedDelivery: number } | null;
};

/** Admin-only data for the order page. Reads stored data only; never calls a courier. */
export async function getOrderIntelligencePanel(orderId: string): Promise<OrderIntelligencePanel | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { trustSnapshot: true, phone: true, shippingSnapshot: true, shippingAddress: { select: { phone: true } } },
  });
  if (!o) return null;
  const phone = checkedPhoneOf(o);
  const stored = await getStoredIntelligence(phone);
  const snap = (o.trustSnapshot ?? null) as { courier?: CourierEvidence; rechecks?: { checkedAt?: string; byId?: string; score?: number | null; tier?: string; status?: string; provider?: string | null }[] } | null;
  let internal: OrderIntelligencePanel["internal"] = null;
  try {
    const profile = await getCustomerRiskProfile({ orderId });
    if (profile) internal = { total: profile.stats.total, delivered: profile.stats.delivered, cancelled: profile.stats.cancelled, failedDelivery: profile.stats.failedDelivery };
  } catch {
    internal = null;
  }
  return {
    phoneMasked: stored.phoneMasked,
    stored: stored.phoneValid ? stored : null,
    unchecked: stored.unchecked,
    atCheckout: snap?.courier && snap.courier.model === "courier-rate-v2" ? snap.courier : null,
    rechecks: (snap?.rechecks ?? []).map((r) => ({ at: r.checkedAt ?? "", byId: r.byId ?? "", rate: typeof r.score === "number" ? r.score : null, tier: r.tier ?? null, status: r.status ?? "", providers: r.provider ?? null })),
    internal,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Customer risk for ANY phone (Fraud Checker page): stored data only, no courier is called
// ---------------------------------------------------------------------------------------------------------------------------------
export type PhoneRiskSummary = {
  phoneValid: boolean;
  phoneMasked: string | null;
  /** Whether fraud scoring is on (Fraud settings). When OFF there is no score to show. */
  riskMode: "OFF" | "ADVISORY" | "ENFORCE";
  /** This website's own orders for the phone (NOT courier history, and never part of the courier rate). */
  internal: { total: number; delivered: number; cancelled: number; failedDelivery: number } | null;
  /** The most recent stored risk assessment of an order placed with this phone, with its reasons. */
  risk: RiskView | null;
  riskOrderNumber: string | null;
};

/**
 * Admin-only. Looks up what this website already knows about a phone: its orders' outcomes and the latest stored risk assessment with every
 * reason. It reads stored records only: it never calls a courier and never recalculates a score. Throttled per admin and audited with the masked
 * phone only.
 */
export async function getPhoneRiskSummary(args: { adminId: string | null | undefined; phone: string }): Promise<PhoneRiskSummary> {
  const adminId = await assertAdminActor(prisma, args.adminId);
  const throttle = await consumeRateLimit(RATE_LIMITS.riskLookupAdmin, [adminId]);
  if (!throttle.ok) throw new UserFacingError(throttledMessage(throttle));
  const { policy } = await getFraudPolicy();
  const phone = normalizeBdPhone(args.phone);
  if (!phone) return { phoneValid: false, phoneMasked: null, riskMode: policy.mode, internal: null, risk: null, riskOrderNumber: null };

  const profile = await getCustomerRiskProfile({ phone });
  const internal = profile ? { total: profile.stats.total, delivered: profile.stats.delivered, cancelled: profile.stats.cancelled, failedDelivery: profile.stats.failedDelivery } : null;

  let risk: RiskView | null = null;
  let riskOrderNumber: string | null = null;
  if (policy.mode !== "OFF" && profile?.currentRisk) {
    const order = await prisma.order.findFirst({ where: { orderNumber: profile.currentRisk.orderNumber }, select: { riskAssessmentId: true } });
    const assessment = order?.riskAssessmentId ? await prisma.orderRiskAssessment.findUnique({ where: { id: order.riskAssessmentId }, select: { signals: true } }) : null;
    const stored = (assessment?.signals ?? null) as { signals?: RiskPanelInput["signals"] } | null;
    const stats = await getStoredIntelligence(phone);
    const input: RiskPanelInput = {
      mode: policy.mode, assessed: true, score: profile.currentRisk.score, level: profile.currentRisk.level as RiskLevel,
      assessedAt: profile.currentRisk.assessedAt, signals: stored?.signals ?? [],
    };
    risk = buildRiskView(input, stats.combined.contributing.length);
    riskOrderNumber = profile.currentRisk.orderNumber;
  }
  await recordAudit(prisma, { actorId: adminId, action: "CUSTOMER_RISK_LOOKUP", entityType: "COURIER_INTELLIGENCE", detail: { phoneMasked: maskPhone(phone), hadRisk: risk !== null } });
  return { phoneValid: true, phoneMasked: maskPhone(phone), riskMode: policy.mode, internal, risk, riskOrderNumber };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Everything the order page shows about courier history and risk, assembled once
// ---------------------------------------------------------------------------------------------------------------------------------
export type OrderCourierView = { panel: OrderIntelligencePanel; history: HistoryView | null; risk: RiskView | null };

/**
 * One call for the order page: the stored courier panel, the display-ready history (per courier, combined, warnings, last checked, saved or fresh)
 * and the order's stored risk score with its reasons. Reads stored data only: opening an order never calls a courier. `fraud` may be passed when the
 * page already loaded it, so it is not read twice.
 */
export async function getOrderCourierView(
  orderId: string,
  opts: { adminId?: string | null; fraud?: OrderFraudPanel | null; nowMs?: number } = {},
): Promise<OrderCourierView | null> {
  const panel = await getOrderIntelligencePanel(orderId);
  if (!panel) return null;
  const history = panel.stored ? buildHistoryView(panel.stored.reports, panel.stored.combined, opts.nowMs) : null;
  const fraud = opts.fraud !== undefined ? opts.fraud : await getOrderFraudPanel(orderId, opts.adminId ?? null);
  const risk = fraud && fraud.mode !== "OFF" ? buildRiskView(fraud, panel.stored ? panel.stored.combined.contributing.length : null) : null;
  return { panel, history, risk };
}
