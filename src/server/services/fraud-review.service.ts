import "server-only";
import type { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { UserFacingError } from "@/lib/errors";
import type { RiskLevel } from "@/lib/fraud/policy";
import { riskGateBlockedReason } from "@/lib/fraud/scoring";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { evaluateOrderRisk, getFraudPolicy } from "@/server/services/fraud-risk.service";

/**
 * Recorded admin decisions on orders held by the fraud-risk gate.
 *
 *  - APPROVE clears ONLY the fraud-review gate (and only up to the level the admin saw: if the risk later escalates the order is held again). It does NOT
 *    confirm the order, and it can never mark an advance verified or satisfy the low-trust review - those are separate gates in advance.service.
 *  - REJECT cancels the order through the existing status funnel (so stock, notifications and audit behave exactly like any other cancellation).
 *  - A reason of at least MIN_REVIEW_REASON characters is mandatory for both. Every decision (and every refused attempt) is written to AdminAuditEvent.
 *  - CRITICAL orders can be restricted to the reviewers listed in the policy (the project has only an ADMIN role, so this is the finer permission).
 *  - The decision is bound to the assessment the admin was looking at: if the score changed in the meantime the decision is refused and they must re-read it.
 */
export const MIN_REVIEW_REASON = 10;
const MAX_REVIEW_REASON = 500;
const REVIEWABLE_STATUSES: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING"];

export type ReviewInput = { orderId: string; adminId: string | null | undefined; decision: "APPROVED" | "REJECTED"; reason: string; assessmentId: string };

export async function reviewRiskOrder(input: ReviewInput, opts: { now?: Date; /** Test seam; defaults to the real status funnel. */ cancelOrder?: typeof adminUpdateOrderStatus } = {}): Promise<{ decision: "APPROVED" | "REJECTED"; level: RiskLevel }> {
  const now = opts.now ?? new Date();
  if (input.decision !== "APPROVED" && input.decision !== "REJECTED") throw new UserFacingError("Choose approve or reject.");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < MIN_REVIEW_REASON) throw new UserFacingError(`Write the reason for this decision (at least ${MIN_REVIEW_REASON} characters). It is recorded in the audit log.`);
  if (reason.length > MAX_REVIEW_REASON) throw new UserFacingError(`The reason is too long (max ${MAX_REVIEW_REASON} characters).`);
  const adminId = await assertAdminActor(prisma, input.adminId);

  const policy = (await getFraudPolicy()).policy;
  const level = await prisma.$transaction(async (tx) => {
    const o = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, orderNumber: true, status: true, channelId: true, riskReviewRequired: true, riskLevel: true, riskScore: true, riskAssessmentId: true },
    });
    if (!o || o.channelId !== WEBSITE_CHANNEL_ID) throw new UserFacingError("Order not found.");
    if (!REVIEWABLE_STATUSES.includes(o.status)) throw new UserFacingError("This order can no longer be reviewed.");
    if (!o.riskReviewRequired || !o.riskLevel) throw new UserFacingError("This order does not need a fraud review.");
    if (o.riskAssessmentId !== input.assessmentId) throw new UserFacingError("The risk assessment changed since you opened this order. Reload the page and review it again.");
    const l = o.riskLevel as RiskLevel;
    return { l, o };
  }).then(async ({ l, o }) => {
    // The permission check is OUTSIDE the transaction so that a refused attempt can still be audited.
    if (l === "CRITICAL" && policy.criticalReviewerIds.length > 0 && !policy.criticalReviewerIds.includes(adminId)) {
      await recordAudit(prisma, { actorId: adminId, action: "RISK_REVIEW_DENIED", entityType: "ORDER", entityId: o.id, detail: { level: l, decision: input.decision } });
      throw new UserFacingError("You are not authorised to review critical-risk orders. Ask one of the designated reviewers.");
    }
    await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: { id: o.id, riskAssessmentId: input.assessmentId, riskReviewRequired: true, status: { in: REVIEWABLE_STATUSES } },
        data: { riskReviewDecision: input.decision, riskReviewedLevel: l, riskReviewedById: adminId, riskReviewedAt: now, riskReviewReason: reason },
      });
      if (res.count !== 1) throw new UserFacingError("The order changed while you were reviewing it. Reload the page and try again.");
      await recordAudit(tx, {
        actorId: adminId,
        action: input.decision === "APPROVED" ? "RISK_ORDER_APPROVED" : "RISK_ORDER_REJECTED",
        entityType: "ORDER", entityId: o.id,
        detail: { level: l, score: o.riskScore, assessmentId: input.assessmentId, reason, overrode: input.decision === "APPROVED" ? l : null },
      });
    });
    return l;
  });

  if (input.decision === "REJECTED") {
    try {
      await (opts.cancelOrder ?? adminUpdateOrderStatus)(input.orderId, "CANCELLED", `Rejected in fraud review: ${reason}`.slice(0, 500), { adminId });
    } catch (error) {
      // Could not cancel (e.g. the status changed): undo the recorded rejection so the record never claims something that did not happen.
      await prisma.order.updateMany({
        where: { id: input.orderId, riskReviewDecision: "REJECTED", riskReviewedAt: now },
        data: { riskReviewDecision: null, riskReviewedLevel: null, riskReviewedById: null, riskReviewedAt: null, riskReviewReason: null },
      });
      await recordAudit(prisma, { actorId: adminId, action: "RISK_ORDER_REJECT_FAILED", entityType: "ORDER", entityId: input.orderId, detail: { reason } });
      throw error;
    }
  }
  return { decision: input.decision, level };
}

/** Admin "recalculate": evaluates the order again right now and records the result. */
export async function recalculateOrderRisk(orderId: string, adminId: string | null | undefined) {
  const id = await assertAdminActor(prisma, adminId);
  const r = await evaluateOrderRisk(orderId, { trigger: "MANUAL", adminId: id });
  if (!r) throw new UserFacingError("Fraud checks are switched off, or this is not a website order.");
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Data for the admin order page (read-only)
// ---------------------------------------------------------------------------------------------------------------------------------
export type OrderFraudPanel = {
  orderId: string;
  mode: "OFF" | "ADVISORY" | "ENFORCE";
  assessed: boolean;
  score: number | null;
  level: RiskLevel | null;
  assessedAt: Date | null;
  assessmentId: string | null;
  reviewRequired: boolean;
  /** True while the gate is still closed for this order (a review is required and none covers the current level). */
  gateOpen: boolean;
  review: { decision: "APPROVED" | "REJECTED"; level: RiskLevel | null; byId: string | null; at: Date | null; reason: string | null } | null;
  canReview: boolean;
  cannotReviewBecause: string | null;
  signals: { code: string; label: string; points: number; detail: string; refs?: string[] }[];
  adjustments: { code: string; detail: string; from: number; to: number }[];
  rawTotal: number | null;
  thresholds: { medium: number; high: number; critical: number };
  history: { score: number; level: RiskLevel; trigger: string; at: Date }[];
};

export async function getOrderFraudPanel(orderId: string, currentAdminId: string | null): Promise<OrderFraudPanel | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, channelId: true, status: true, riskScore: true, riskLevel: true, riskAssessedAt: true, riskAssessmentId: true, riskReviewRequired: true,
      riskReviewDecision: true, riskReviewedLevel: true, riskReviewedById: true, riskReviewedAt: true, riskReviewReason: true,
    },
  });
  if (!o || o.channelId !== WEBSITE_CHANNEL_ID) return null;
  const { policy } = await getFraudPolicy();
  const history = await prisma.orderRiskAssessment.findMany({ where: { orderId }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, score: true, level: true, trigger: true, signals: true, createdAt: true } });
  const latest = history.find((h) => h.id === o.riskAssessmentId) ?? history[0] ?? null;
  const stored = (latest?.signals ?? null) as { signals?: OrderFraudPanel["signals"]; adjustments?: OrderFraudPanel["adjustments"]; rawTotal?: number } | null;
  const level = (o.riskLevel as RiskLevel | null) ?? null;
  const gateOpen = !riskGateBlockedReason({
    riskReviewRequired: o.riskReviewRequired, riskLevel: level, riskReviewDecision: o.riskReviewDecision, riskReviewedLevel: (o.riskReviewedLevel as RiskLevel | null) ?? null,
  });
  const active = REVIEWABLE_STATUSES.includes(o.status);
  const restricted = level === "CRITICAL" && policy.criticalReviewerIds.length > 0 && !(currentAdminId && policy.criticalReviewerIds.includes(currentAdminId));
  const canReview = active && o.riskReviewRequired && !gateOpen && !restricted;
  return {
    orderId, mode: policy.mode, assessed: o.riskScore != null, score: o.riskScore, level, assessedAt: o.riskAssessedAt, assessmentId: o.riskAssessmentId, reviewRequired: o.riskReviewRequired, gateOpen,
    review: o.riskReviewDecision ? { decision: o.riskReviewDecision as "APPROVED" | "REJECTED", level: (o.riskReviewedLevel as RiskLevel | null) ?? null, byId: o.riskReviewedById, at: o.riskReviewedAt, reason: o.riskReviewReason } : null,
    canReview, cannotReviewBecause: restricted && o.riskReviewRequired && !gateOpen ? "Critical-risk orders can only be reviewed by the designated reviewers (Fraud settings)." : null,
    signals: stored?.signals ?? [], adjustments: stored?.adjustments ?? [], rawTotal: stored?.rawTotal ?? null, thresholds: policy.thresholds,
    history: history.map((h) => ({ score: h.score, level: h.level as RiskLevel, trigger: h.trigger, at: h.createdAt })),
  };
}
