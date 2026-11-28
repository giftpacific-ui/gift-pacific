import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { UserFacingError } from "@/lib/errors";
import { logServerError } from "@/lib/logger";
import { normalizeIp, orderIdentity } from "@/lib/fraud/identity";
import { DEFAULT_FRAUD_POLICY, resolveFraudPolicy, validateFraudPolicy, type FraudPolicy, type RiskLevel } from "@/lib/fraud/policy";
import { scoreOrderRisk } from "@/lib/fraud/scoring";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { gatherRiskEvidence, type EvaluatedOrder } from "@/server/services/fraud-evidence.service";

/**
 * Central fraud-risk service: policy, evaluation, persistence and maintenance.
 *
 *  - `evaluateOrderRisk` reads the real evidence, scores it (lib/fraud/scoring.ts), stores a NEW OrderRiskAssessment only when the result differs from
 *    the previous one (an identical re-evaluation just refreshes Order.riskAssessedAt), and updates the order's risk columns and review gate.
 *  - It runs when the order is placed (an early warning, with the visitor's IP), again at the moment an admin tries to confirm it (so a block added
 *    after checkout, or new activity, is seen), and on demand.
 *  - It only ever sets the FRAUD-review gate. It does not touch advance payments, the low-trust review, payment status or the order status: those
 *    stay with advance.service / order.service and can never be satisfied by anything here.
 *  - Nothing in this file is reachable with client-supplied scores: the inputs are database rows and the server-observed IP.
 */
type Db = typeof prisma;
type Trigger = "CHECKOUT" | "CONFIRM" | "MANUAL" | "RECALC";
const ACTIVE_STATUSES = ["PENDING", "CONFIRMED", "PROCESSING"];

// ------------------------------------------------------------------------------------------------------------------------------ policy
export async function getFraudPolicy(db: Db = prisma): Promise<{ policy: FraudPolicy; problem: string | null }> {
  const s = await db.storeSettings.findFirst({ select: { fraudPolicy: true } });
  return resolveFraudPolicy(s?.fraudPolicy ?? null);
}

/** Saves the policy (a partial override is merged over the defaults and VALIDATED; invalid input is refused, never silently weakened). Audited with before/after. */
export async function saveFraudPolicy(override: unknown, adminId: string | null) {
  const before = (await getFraudPolicy()).policy;
  const { policy, problem } = resolveFraudPolicy(override);
  // resolveFraudPolicy falls back to defaults on invalid input; for a SAVE the admin must be told, not silently reset.
  const check = validateFraudPolicy(mergeForSave(override));
  if (problem || check) throw new UserFacingError(check ?? problem ?? "Invalid fraud policy.");
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, adminId);
    const existing = await tx.storeSettings.findFirst({ select: { id: true } });
    if (!existing) throw new UserFacingError("Store settings are not initialised yet.");
    await tx.storeSettings.update({ where: { id: existing.id }, data: { fraudPolicy: policy as unknown as Prisma.InputJsonValue } });
    await recordAudit(tx, { actorId: adminId, action: "FRAUD_POLICY_UPDATED", entityType: "SETTINGS", entityId: existing.id, detail: { before: summarisePolicy(before), after: summarisePolicy(policy) } });
  });
  return policy;
}

function mergeForSave(override: unknown): FraudPolicy {
  // Same merge the resolver uses, but returned even when invalid so validate() can name the problem.
  const base = structuredClone(DEFAULT_FRAUD_POLICY) as unknown as Record<string, unknown>;
  const apply = (b: Record<string, unknown>, o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (!(k in b)) continue;
      const cur = b[k];
      if (cur && typeof cur === "object" && !Array.isArray(cur)) apply(cur as Record<string, unknown>, v);
      else b[k] = v;
    }
  };
  apply(base, override);
  return base as unknown as FraudPolicy;
}

const summarisePolicy = (p: FraudPolicy) => ({ mode: p.mode, thresholds: p.thresholds, reviewFrom: p.reviewFrom, blockAction: p.blockAction, ipRetentionDays: p.ipRetentionDays, restrictedReviewers: p.criticalReviewerIds.length });

// ------------------------------------------------------------------------------------------------------------------------- evaluation
export type EvaluationResult = {
  assessmentId: string; score: number; level: RiskLevel; changed: boolean; reviewRequired: boolean; calculatedAt: Date;
};

async function loadEvaluatedOrder(db: Db, orderId: string) {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, status: true, channelId: true, userId: true, phone: true, email: true, total: true, createdAt: true, shippingSnapshot: true,
      trustScore: true, trustSnapshot: true, phoneNorm: true, emailNorm: true, addressKey: true, riskAssessmentId: true, riskReviewRequired: true,
      items: { select: { productId: true, variantId: true, quantity: true } },
    },
  });
  return o;
}

const signatureOf = (score: number, level: string, signals: { code: string; points: number }[]) => JSON.stringify([score, level, signals.map((s) => [s.code, s.points])]);

/**
 * Evaluates one order. Returns null when the policy mode is OFF, the order is not a website order, or it does not exist (nothing is written then).
 * `ip` is the visitor's address as the SERVER saw it (never a client-supplied value); on a re-evaluation without one, the IP stored with the last
 * assessment (if still inside retention) is reused so the IP signal is not lost.
 */
export async function evaluateOrderRisk(
  orderId: string,
  opts: { trigger: Trigger; ip?: string | null; adminId?: string | null; now?: Date; db?: Db },
): Promise<EvaluationResult | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const { policy } = await getFraudPolicy(db);
  if (policy.mode === "OFF") return null;
  const order = await loadEvaluatedOrder(db, orderId);
  if (!order || order.channelId !== WEBSITE_CHANNEL_ID) return null;

  const id = orderIdentity({ phone: order.phone, email: order.email, shippingSnapshot: order.shippingSnapshot });
  const previous = order.riskAssessmentId ? await db.orderRiskAssessment.findUnique({ where: { id: order.riskAssessmentId } }) : null;
  const ip = normalizeIp(opts.ip ?? null) ?? previous?.clientIp ?? null;

  const { evidence, meta } = await gatherRiskEvidence(
    db,
    {
      id: order.id, orderNumber: order.orderNumber, userId: order.userId, total: Number(order.total), createdAt: order.createdAt,
      phones: id.phones, emailNorm: id.emailNorm, addressKey: id.addressKey, trustScore: order.trustScore, trustSnapshot: order.trustSnapshot,
      shippingSnapshot: order.shippingSnapshot, items: order.items,
    },
    { ip, policy, now },
  );
  const result = scoreOrderRisk(evidence, policy);
  const sig = signatureOf(result.score, result.level, result.signals);

  // Identity keys are filled in for orders placed before they existed, so this order can be found by later evaluations of other orders.
  const keyPatch: Record<string, unknown> = {};
  if (order.phoneNorm == null) keyPatch.phoneNorm = id.phoneNorm ?? "-";
  if (order.emailNorm == null && id.emailNorm) keyPatch.emailNorm = id.emailNorm;
  if (order.addressKey == null && id.addressKey) keyPatch.addressKey = id.addressKey;

  // Stored as { signals, adjustments, rawTotal } (see the create below); compare like with like.
  const storedSignals = ((previous?.signals as { signals?: { code: string; points: number }[] } | null)?.signals) ?? [];
  const unchanged = previous && signatureOf(previous.score, previous.level, storedSignals) === sig;
  let assessmentId = previous?.id ?? "";
  if (!unchanged) {
    const created = await db.orderRiskAssessment.create({
      data: {
        orderId: order.id, score: result.score, level: result.level, trigger: opts.trigger,
        signals: { signals: result.signals, adjustments: result.adjustments, rawTotal: result.rawTotal } as unknown as Prisma.InputJsonValue,
        policy: policy as unknown as Prisma.InputJsonValue,
        evidence: { ...meta, trigger: opts.trigger } as unknown as Prisma.InputJsonValue,
        clientIp: ip, calculatedById: opts.adminId ?? null,
        // The evaluation time (not the insert time): windows and retention are all measured from `now`, so the row must carry the same clock.
        createdAt: now,
      },
    });
    assessmentId = created.id;
  }

  // The gate flag follows the latest assessment for orders that can still be confirmed/dispatched; finished orders keep what they had.
  const live = ACTIVE_STATUSES.includes(order.status);
  await db.order.update({
    where: { id: order.id },
    data: {
      ...keyPatch,
      riskScore: result.score, riskLevel: result.level, riskAssessedAt: now, riskAssessmentId: assessmentId,
      ...(live ? { riskReviewRequired: result.reviewRequired } : {}),
    },
  });
  if (opts.trigger === "MANUAL" || opts.trigger === "RECALC") {
    await recordAudit(db, { actorId: opts.adminId ?? null, action: "RISK_RECALCULATED", entityType: "ORDER", entityId: order.id, detail: { score: result.score, level: result.level, changed: !unchanged } });
  }
  return { assessmentId, score: result.score, level: result.level, changed: !unchanged, reviewRequired: result.reviewRequired, calculatedAt: now };
}

/**
 * Called by adminUpdateOrderStatus BEFORE the gate runs, when a pending website order is being confirmed: the gate then sees fresh evidence.
 * If evaluation fails and the order has NO assessment at all, the confirmation is refused (fail closed: an unassessed order is never silently
 * confirmed). If a previous assessment exists, its stored result keeps governing the gate and the failure is logged.
 */
export async function ensureRiskAssessed(orderId: string, opts: { db?: Db } = {}): Promise<void> {
  const db = opts.db ?? prisma;
  try {
    await evaluateOrderRisk(orderId, { trigger: "CONFIRM", db });
  } catch (error) {
    logServerError("fraud.ensure-assessed", error);
    const o = await db.order.findUnique({ where: { id: orderId }, select: { channelId: true, riskAssessmentId: true } }).catch(() => null);
    if (o && o.channelId === WEBSITE_CHANNEL_ID && !o.riskAssessmentId) {
      throw new UserFacingError("The fraud-risk check could not be completed for this order. Please try again in a moment.");
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------------- maintenance
export type FraudMaintenanceSummary = { ipPurged: number; keysBackfilled: number };

/**
 * Retention + housekeeping, run by the scheduled job (or "Run now" in admin):
 *  - IP addresses on assessments older than `ipRetentionDays` are set to NULL (the score, signals and history stay);
 *  - website orders placed before P4 get their phone / e-mail / address keys so history matching covers them ("-" marks "no valid phone").
 */
export async function runFraudMaintenance(opts: { now?: Date; batch?: number; db?: Db } = {}): Promise<FraudMaintenanceSummary> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const { policy } = await getFraudPolicy(db);
  const purged = await db.orderRiskAssessment.updateMany({
    where: { clientIp: { not: null }, createdAt: { lt: new Date(now.getTime() - policy.ipRetentionDays * 86_400_000) } },
    data: { clientIp: null },
  });
  const todo = await db.order.findMany({
    where: { channelId: WEBSITE_CHANNEL_ID, phoneNorm: null },
    select: { id: true, phone: true, email: true, shippingSnapshot: true },
    take: opts.batch ?? 200,
  });
  for (const o of todo) {
    const id = orderIdentity(o);
    await db.order.update({ where: { id: o.id }, data: { phoneNorm: id.phoneNorm ?? "-", emailNorm: id.emailNorm, addressKey: id.addressKey } });
  }
  return { ipPurged: purged.count, keysBackfilled: todo.length };
}

/** Active admins (id, name) for the "who may review CRITICAL orders" setting. Admin-only data, read on an admin page. */
export async function listActiveAdmins(db: Db = prisma): Promise<{ id: string; name: string | null; email: string }[]> {
  return db.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" }, take: 100 });
}
