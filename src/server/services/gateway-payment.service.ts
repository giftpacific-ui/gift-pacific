import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma, type GatewayTransaction } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { UserFacingError } from "@/lib/errors";
import { logServerError } from "@/lib/logger";
import { absoluteUrl } from "@/lib/seo";
import { normalizeTxnRef } from "@/lib/payment-reference";
import {
  BkashError,
  bkashCreatePayment,
  bkashExecutePayment,
  bkashQueryPayment,
  bkashRefund,
  bkashRefundStatus,
  bkashTestConnection,
  getBkashConfig,
  isBkashUsable,
  type BkashPaymentState,
} from "@/lib/payments/bkash";
import { advanceOutstanding, assertAdminActor, recordAudit, syncOrderPayment } from "@/server/services/advance.service";
import { notifyUser } from "@/server/services/notification.service";
import { recordIncident } from "@/server/services/incident.service";

/**
 * Online bKash payments for the ADVANCE a customer owes.
 *
 * Rules enforced here (and nowhere else):
 *  - the amount is computed on the server from the order; the browser sends nothing but the order number;
 *  - a Payment row (and Order.advancePaid) is created ONLY after the provider confirms the payment server-to-server and
 *    the amount, currency and invoice number match; a redirect, a query-string status or a failed/cancelled/expired/
 *    unverified attempt never changes a payment or an order;
 *  - one wallet transaction id can credit at most once (Payment has UNIQUE(method, providerRef));
 *  - success never changes the order's status, fraud-review state or stock: dispatch is still gated by assertDispatchReady.
 */

const TXN_TTL_MS = 30 * 60 * 1000;
/** A VERIFYING claim older than this is treated as abandoned (a crashed request) and may be taken over. */
const VERIFYING_STALE_MS = 2 * 60 * 1000;
const PAYABLE_ORDER_STATUSES = ["PENDING", "CONFIRMED"] as const;
const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED", "NEEDS_REVIEW"] as const;
const cents = (n: unknown) => Math.round(Number(n) * 100);

export type PayOption = { available: boolean; amount: number; reason: string | null; resumeUrl: string | null };

/** What the signed-in customer's order page may offer for THEIR order. Server-computed; shown only when bKash is genuinely usable. */
export async function getBkashPayOption(orderNumber: string): Promise<PayOption> {
  const none: PayOption = { available: false, amount: 0, reason: null, resumeUrl: null };
  const config = getBkashConfig();
  if (!isBkashUsable(config)) return none;
  const session = await getSession();
  if (!session) return none;
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: session.sub },
    select: { id: true, status: true, advanceRequired: true, advancePaid: true, advanceWaivedById: true },
  });
  if (!order || !(PAYABLE_ORDER_STATUSES as readonly string[]).includes(order.status) || !advanceOutstanding(order)) return none;
  const amount = (cents(order.advanceRequired) - cents(order.advancePaid)) / 100;
  const open = await prisma.gatewayTransaction.findFirst({
    where: { orderId: order.id, provider: "BKASH", purpose: "ADVANCE", status: "PENDING_APPROVAL", expiresAt: { gt: new Date() } },
    select: { redirectUrl: true },
  });
  return { available: amount > 0, amount, reason: null, resumeUrl: open?.redirectUrl ?? null };
}

/** Starts (or resumes) a bKash payment for the signed-in customer's own order and returns where to send them. */
export async function initiateBkashAdvance(orderNumber: string): Promise<{ redirectUrl: string }> {
  const session = await getSession();
  if (!session) throw new UserFacingError("Please sign in to pay for your order.");
  const config = getBkashConfig();
  if (!isBkashUsable(config)) throw new UserFacingError("Online bKash payment is not available right now.");
  if (typeof orderNumber !== "string" || !orderNumber) throw new UserFacingError("Order not found.");

  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: session.sub }, // ownership is part of the query
    select: { id: true, orderNumber: true, status: true, advanceRequired: true, advancePaid: true, advanceWaivedById: true },
  });
  if (!order) throw new UserFacingError("Order not found.");
  if (!(PAYABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) throw new UserFacingError("This order can no longer be paid online.");
  if (!advanceOutstanding(order)) throw new UserFacingError("There is no advance payment due on this order.");
  const amount = (cents(order.advanceRequired) - cents(order.advancePaid)) / 100;
  if (amount <= 0) throw new UserFacingError("There is no advance payment due on this order.");

  // An attempt may already be open: resume it, or settle it first if it has run out of time.
  const open = await prisma.gatewayTransaction.findFirst({ where: { orderId: order.id, provider: "BKASH", purpose: "ADVANCE", status: { in: ["INITIATED", "PENDING_APPROVAL", "VERIFYING"] } } });
  if (open) {
    if (open.status === "PENDING_APPROVAL" && open.expiresAt > new Date() && open.redirectUrl) return { redirectUrl: open.redirectUrl };
    if (open.status === "INITIATED" && Date.now() - open.createdAt.getTime() > 2 * 60 * 1000) {
      await prisma.gatewayTransaction.updateMany({ where: { id: open.id, status: "INITIATED" }, data: { status: "FAILED", failureReason: "The payment never reached bKash." } });
    } else if (open.status === "PENDING_APPROVAL") {
      await verifyGatewayTransaction(open.id, { allowExecute: false });
    } else {
      throw new UserFacingError("A payment for this order is already being processed. Please wait a moment.");
    }
  }

  let txn: GatewayTransaction;
  try {
    txn = await prisma.gatewayTransaction.create({
      data: {
        provider: "BKASH",
        orderId: order.id,
        purpose: "ADVANCE",
        merchantInvoiceNumber: `${order.orderNumber}-${randomBytes(4).toString("hex")}`.slice(0, 40),
        amount,
        environment: config.environment,
        expiresAt: new Date(Date.now() + TXN_TTL_MS),
      },
    });
  } catch (error) {
    // The partial unique index ("one open attempt per order") fired: a concurrent request won.
    if ((error as { code?: string }).code === "P2002") throw new UserFacingError("A payment for this order is already in progress.");
    throw error;
  }

  try {
    const created = await bkashCreatePayment(config, {
      amount,
      merchantInvoiceNumber: txn.merchantInvoiceNumber,
      callbackUrl: absoluteUrl("/api/payments/bkash/callback"),
      payerReference: order.orderNumber,
    });
    await prisma.gatewayTransaction.update({
      where: { id: txn.id },
      data: { providerPaymentId: created.paymentId, redirectUrl: created.bkashUrl, status: "PENDING_APPROVAL", providerStatus: created.transactionStatus, providerStatusCode: created.statusCode, rawInitiate: created.raw as Prisma.InputJsonValue },
    });
    return { redirectUrl: created.bkashUrl };
  } catch (error) {
    const reason = error instanceof BkashError ? error.message : "Could not start the payment.";
    logServerError("gateway.bkash.initiate", error, { txn: txn.id });
    // Without a provider payment id nothing can be paid or credited, so closing the attempt is always safe.
    await prisma.gatewayTransaction.updateMany({ where: { id: txn.id, status: "INITIATED" }, data: { status: "FAILED", failureReason: reason.slice(0, 300) } });
    throw new UserFacingError("We could not start the bKash payment. Please try again in a moment.");
  }
}

function statusFromProvider(state: BkashPaymentState): "COMPLETED" | "CANCELLED" | "FAILED" | "EXPIRED" | "OPEN" | "UNKNOWN" {
  const s = (state.transactionStatus ?? "").toLowerCase();
  if (s === "completed") return "COMPLETED";
  if (s.includes("cancel")) return "CANCELLED";
  if (s.includes("expire")) return "EXPIRED";
  if (s.includes("fail") || s.includes("declin")) return "FAILED";
  if (s === "initiated" || s === "authorized" || s === "pending") return "OPEN";
  return "UNKNOWN";
}

/**
 * Settles one transaction from the PROVIDER's answer. `allowExecute` is true only when the customer came back from bKash
 * saying "success": the payment is then executed server-side (that call is what actually charges the wallet). In every other
 * case the payment is only QUERIED. `hint` is the browser's claim and is used for nothing except choosing a failure label
 * once the provider has confirmed the payment did not complete.
 */
export async function verifyGatewayTransaction(id: string, opts: { allowExecute: boolean; hint?: "success" | "failure" | "cancel" }): Promise<GatewayTransaction> {
  const current = await prisma.gatewayTransaction.findUniqueOrThrow({ where: { id } });
  if ((TERMINAL as readonly string[]).includes(current.status)) return current;
  if (!current.providerPaymentId) {
    // The attempt never got a provider payment id (the create call failed or the request died): nothing can have been paid.
    if (current.status === "INITIATED" && Date.now() - current.createdAt.getTime() > 2 * 60 * 1000) {
      await prisma.gatewayTransaction.updateMany({ where: { id, status: "INITIATED" }, data: { status: "FAILED", failureReason: "The payment never reached bKash." } });
      return prisma.gatewayTransaction.findUniqueOrThrow({ where: { id } });
    }
    return current;
  }

  // Exactly one request may verify at a time (and a crashed claim can be taken over).
  const claimed = await prisma.gatewayTransaction.updateMany({
    where: {
      id,
      OR: [{ status: "PENDING_APPROVAL" }, { status: "VERIFYING", updatedAt: { lt: new Date(Date.now() - VERIFYING_STALE_MS) } }],
    },
    data: { status: "VERIFYING" },
  });
  if (claimed.count !== 1) return prisma.gatewayTransaction.findUniqueOrThrow({ where: { id } });

  const release = (data: Prisma.GatewayTransactionUpdateManyMutationInput) => prisma.gatewayTransaction.updateMany({ where: { id, status: "VERIFYING" }, data });
  const config = getBkashConfig();
  if (!isBkashUsable(config)) {
    await release({ status: "PENDING_APPROVAL" });
    throw new UserFacingError("Online payment verification is not available right now.");
  }

  let state: BkashPaymentState | null = null;
  try {
    if (opts.allowExecute) {
      try {
        state = await bkashExecutePayment(config, current.providerPaymentId);
      } catch (error) {
        // Execute is never re-sent. Whether it failed, timed out or was already done, the provider's QUERY is the source of truth.
        if (!(error instanceof BkashError)) throw error;
      }
    }
    if (!state || statusFromProvider(state) !== "COMPLETED") state = await bkashQueryPayment(config, current.providerPaymentId);
  } catch (error) {
    logServerError("gateway.bkash.verify", error, { txn: id });
    // Could not learn the truth: leave it open so it can be re-checked (nothing was credited).
    await release({ status: "PENDING_APPROVAL" });
    return prisma.gatewayTransaction.findUniqueOrThrow({ where: { id } });
  }

  const outcome = statusFromProvider(state);
  const common = { providerStatus: state.transactionStatus, providerStatusCode: state.statusCode, rawVerify: state.raw as Prisma.InputJsonValue };

  if (outcome === "COMPLETED") return finalizeSuccess(current, state);

  const expired = current.expiresAt <= new Date();
  if (outcome === "CANCELLED" || (outcome !== "OPEN" && opts.hint === "cancel")) {
    await release({ ...common, status: "CANCELLED", failureReason: "The customer cancelled the payment." });
  } else if (outcome === "EXPIRED" || (outcome === "OPEN" && expired)) {
    await release({ ...common, status: "EXPIRED", failureReason: "The payment was not completed in time." });
  } else if (outcome === "FAILED" || (outcome === "UNKNOWN" && opts.hint === "failure")) {
    await release({ ...common, status: "FAILED", failureReason: (state.statusMessage ?? "The payment did not complete.").slice(0, 300) });
  } else {
    // Still open (the customer has not finished) or an unrecognised status: never guess, keep it open.
    await release({ ...common, status: "PENDING_APPROVAL" });
  }
  const after = await prisma.gatewayTransaction.findUniqueOrThrow({ where: { id } });
  if (after.status === "FAILED" || after.status === "CANCELLED" || after.status === "EXPIRED") await notifyOutcome(after);
  return after;
}

async function notifyOutcome(txn: GatewayTransaction) {
  const order = await prisma.order.findUnique({ where: { id: txn.orderId }, select: { userId: true, orderNumber: true } });
  await notifyUser(prisma, {
    userId: order?.userId,
    type: "PAYMENT",
    title: txn.status === "CANCELLED" ? "Payment cancelled" : "Payment was not completed",
    body: `Your bKash payment for order ${order?.orderNumber} did not go through. You were not charged by us; you can try again from the order page.`,
    href: order ? `/account/orders/${order.orderNumber}` : null,
    dedupeKey: `gateway:${txn.id}:${txn.status.toLowerCase()}`,
  });
}

/** Provider says COMPLETED. Verify it is the payment we created, then credit once, inside one transaction. */
async function finalizeSuccess(txn: GatewayTransaction, state: BkashPaymentState): Promise<GatewayTransaction> {
  const review = async (reason: string, trx?: string | null) => {
    await prisma.gatewayTransaction.updateMany({
      where: { id: txn.id, status: "VERIFYING" },
      data: { status: "NEEDS_REVIEW", failureReason: reason.slice(0, 300), providerTrxId: trx ?? state.trxId, providerStatus: state.transactionStatus, providerStatusCode: state.statusCode, rawVerify: state.raw as Prisma.InputJsonValue },
    });
    logServerError("gateway.bkash.needs_review", new Error(reason), { txn: txn.id });
    return prisma.gatewayTransaction.findUniqueOrThrow({ where: { id: txn.id } });
  };

  const ref = normalizeTxnRef(state.trxId);
  if (!ref.ok) return review("The provider confirmed the payment without a usable transaction id.");
  if (state.paymentId && state.paymentId !== txn.providerPaymentId) return review("The provider's payment id does not match this attempt.", ref.value);
  if (state.merchantInvoiceNumber && state.merchantInvoiceNumber !== txn.merchantInvoiceNumber) return review("The provider's invoice number does not match this attempt.", ref.value);
  if (state.currency && state.currency.toUpperCase() !== "BDT") return review(`The provider reported currency ${state.currency}.`, ref.value);
  if (state.amount === null || cents(state.amount) !== cents(txn.amount)) return review(`Amount mismatch: expected ${Number(txn.amount).toFixed(2)}, provider reported ${state.amount ?? "none"}.`, ref.value);

  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: txn.orderId },
        select: { id: true, total: true, advancePaid: true, advanceRequired: true, advanceWaivedById: true, status: true, userId: true, orderNumber: true },
      });
      const amount = cents(txn.amount) / 100;
      const paid = (cents(order.advancePaid) + cents(amount)) / 100;
      const blocked =
        !(PAYABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
          ? "The order is no longer payable (it was changed after the payment started)."
          : cents(paid) > cents(order.total)
            ? "Crediting this payment would exceed the order total."
            : null;
      if (blocked) throw new NeedsReview(blocked);
      // The advance may have been paid (or waived) another way while this payment was in flight: the money is real, so a person decides.
      if (!advanceOutstanding(order)) throw new NeedsReview("The advance on this order was already paid or waived while this payment was in progress.");
      const dup = await tx.payment.findFirst({ where: { method: "BKASH", providerRef: { equals: ref.value, mode: "insensitive" } }, select: { id: true } });
      if (dup) throw new NeedsReview("That wallet transaction id is already recorded on another payment.");

      const claimed = await tx.gatewayTransaction.updateMany({ where: { id: txn.id, status: "VERIFYING" }, data: { status: "SUCCEEDED", providerTrxId: ref.value, verifiedAt: new Date(), providerStatus: state.transactionStatus, providerStatusCode: state.statusCode, rawVerify: state.raw as Prisma.InputJsonValue, failureReason: null } });
      if (claimed.count !== 1) return; // someone else already settled it
      const payment = await tx.payment.create({
        data: { orderId: order.id, method: "BKASH", status: "PAID", amount, kind: "ADVANCE", providerRef: ref.value, verifiedAt: new Date(), rawResponse: { gatewayTransactionId: txn.id, providerPaymentId: txn.providerPaymentId } },
      });
      await tx.gatewayTransaction.update({ where: { id: txn.id }, data: { paymentId: payment.id } });
      await tx.order.update({ where: { id: order.id }, data: { advancePaid: paid } });
      await syncOrderPayment(tx, order.id);
      await tx.orderTrackingEvent.create({ data: { orderId: order.id, status: order.status, note: `Advance of ${amount} paid online with bKash and confirmed by bKash.` } });
      await notifyUser(tx, {
        userId: order.userId,
        type: "PAYMENT",
        title: "Payment received",
        body: `Your bKash payment for order ${order.orderNumber} was confirmed.`,
        href: `/account/orders/${order.orderNumber}`,
        dedupeKey: `payment:${payment.id}:verified`,
      });
    });
  } catch (error) {
    if (error instanceof NeedsReview) return review(error.message, ref.value);
    if ((error as { code?: string }).code === "P2002") return review("That wallet transaction id is already recorded on another payment.", ref.value);
    throw error;
  }
  return prisma.gatewayTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

class NeedsReview extends Error {}

/** The browser's `status` claim, normalised (bKash libraries document success/failure/cancel and spelling variants). Anything else is no hint at all. */
export function callbackHint(status: string | null): "success" | "failure" | "cancel" | undefined {
  const v = (status ?? "").trim().toLowerCase();
  if (v === "success") return "success";
  if (["failure", "fail", "failed"].includes(v)) return "failure";
  if (["cancel", "cancelled", "canceled"].includes(v)) return "cancel";
  return undefined;
}

/** Browser return from bKash. The query-string values are hints only; the outcome comes from the provider. */
export async function handleBkashReturn(paymentId: string, status: string | null): Promise<{ orderNumber: string | null; outcome: "success" | "cancelled" | "failed" | "pending" | "review" | "unknown" }> {
  const txn = await prisma.gatewayTransaction.findUnique({ where: { providerPaymentId: paymentId }, select: { id: true, order: { select: { orderNumber: true } } } });
  if (!txn) return { orderNumber: null, outcome: "unknown" };
  const hint = callbackHint(status);
  let result: GatewayTransaction;
  try {
    result = await verifyGatewayTransaction(txn.id, { allowExecute: hint === "success", hint });
  } catch (error) {
    logServerError("gateway.bkash.return", error, { txn: txn.id });
    return { orderNumber: txn.order.orderNumber, outcome: "pending" };
  }
  const outcome = result.status === "SUCCEEDED" ? "success" : result.status === "CANCELLED" ? "cancelled" : result.status === "NEEDS_REVIEW" ? "review" : result.status === "FAILED" || result.status === "EXPIRED" ? "failed" : "pending";
  return { orderNumber: txn.order.orderNumber, outcome };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function recheckGatewayTransaction(id: string, adminId: string): Promise<GatewayTransaction> {
  await prisma.$transaction((tx) => assertAdminActor(tx, adminId));
  const result = await verifyGatewayTransaction(id, { allowExecute: false });
  await prisma.$transaction((tx) => recordAudit(tx, { actorId: adminId, action: "GATEWAY_RECHECK", entityType: "ORDER", entityId: result.orderId, detail: { transactionId: id, status: result.status } }));
  return result;
}

export async function testBkashConnection(): Promise<{ ok: true } | { ok: false; message: string }> {
  const config = getBkashConfig();
  if (config.missing.length > 0 || !config.appKey) return { ok: false, message: config.problem ?? "Not configured." };
  try {
    await bkashTestConnection(config);
    return { ok: true };
  } catch (error) {
    logServerError("gateway.bkash.test", error);
    return { ok: false, message: error instanceof BkashError ? error.message : "Connection failed." };
  }
}

const REFUNDABLE_ORDER_STATUSES = ["REFUND_REQUESTED", "REFUNDED", "CANCELLED"] as const;

/**
 * Sends a refund to bKash for a payment that bKash itself confirmed. It does NOT touch the order's refund accounting
 * (that stays with the existing refund flow); it records what the provider did. A refund is never reported as done until
 * bKash says so, a timed-out request stays PENDING until it is synced, and a repeated submit (same key) changes nothing.
 */
export async function refundGatewayTransaction(args: { transactionId: string; adminId: string; amount: number; reason: string; idempotencyKey: string }) {
  await prisma.$transaction((tx) => assertAdminActor(tx, args.adminId)); // authorise before any validation or configuration answer
  const reason = args.reason?.trim().slice(0, 200) ?? "";
  if (reason.length < 3) throw new UserFacingError("Enter a reason for the refund.");
  if (!Number.isFinite(args.amount) || args.amount <= 0) throw new UserFacingError("Enter the amount to refund.");
  const amount = cents(args.amount) / 100;
  if (typeof args.idempotencyKey !== "string" || args.idempotencyKey.length < 8 || args.idempotencyKey.length > 80) throw new UserFacingError("Invalid request. Reload the page and try again.");
  const config = getBkashConfig();
  if (!isBkashUsable(config)) throw new UserFacingError("bKash is not configured.");

  const refund = await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gwrefund:${args.transactionId}`}))`;
    const existing = await tx.gatewayRefund.findUnique({ where: { idempotencyKey: args.idempotencyKey } });
    if (existing) return { row: existing, fresh: false };
    const txn = await tx.gatewayTransaction.findUnique({ where: { id: args.transactionId }, include: { order: { select: { status: true, orderNumber: true } }, refunds: { select: { amount: true, status: true } } } });
    if (!txn || txn.provider !== "BKASH") throw new UserFacingError("Transaction not found.");
    if (txn.status !== "SUCCEEDED" || !txn.paymentId || !txn.providerTrxId || !txn.providerPaymentId) throw new UserFacingError("Only a payment confirmed by bKash can be refunded.");
    if (!(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(txn.order.status)) throw new UserFacingError("Refunds are only sent for orders that are cancelled or have a refund request.");
    const already = txn.refunds.filter((r) => r.status !== "FAILED").reduce((s, r) => s + cents(r.amount), 0);
    if (already + cents(amount) > cents(txn.amount)) throw new UserFacingError(`Only ${((cents(txn.amount) - already) / 100).toFixed(2)} of this payment can still be refunded.`);
    const row = await tx.gatewayRefund.create({ data: { transactionId: txn.id, amount, reason, idempotencyKey: args.idempotencyKey, requestedById: args.adminId } });
    await recordAudit(tx, { actorId: args.adminId, action: "GATEWAY_REFUND_REQUESTED", entityType: "ORDER", entityId: txn.orderId, detail: { refundId: row.id, amount, transactionId: txn.id } });
    return { row, fresh: true };
  });
  if (!refund.fresh) return refund.row; // a repeated submit: report the existing refund, send nothing

  return sendRefundToProvider(refund.row.id, args.adminId);
}

/**
 * The ONLY place a refund request is sent to bKash. It first claims the submission with a conditional update
 * (submittedAt: null -> now), so it can never be sent twice by a double click, a retry or two admins. After the claim,
 * a refund that is still PENDING is "uncertain": the request may have reached bKash, so it is NEVER resent: it is only
 * queried (syncGatewayRefund) or resolved by an admin.
 */
async function sendRefundToProvider(refundId: string, adminId: string) {
  const config = getBkashConfig();
  if (!isBkashUsable(config)) throw new UserFacingError("bKash is not configured.");
  const claim = await prisma.gatewayRefund.updateMany({ where: { id: refundId, status: "PENDING", submittedAt: null }, data: { submittedAt: new Date() } });
  if (claim.count !== 1) return prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId } }); // already sent (or finished)

  const refund = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: { include: { order: { select: { orderNumber: true } } } } } });
  const txn = refund.transaction;
  try {
    const result = await bkashRefund(config, { paymentId: txn.providerPaymentId as string, trxId: txn.providerTrxId as string, amount: Number(refund.amount), sku: txn.order.orderNumber, reason: refund.reason });
    const done = (result.transactionStatus ?? "").toLowerCase() === "completed";
    const saved = await prisma.gatewayRefund.update({
      where: { id: refundId },
      data: { status: done ? "SUCCEEDED" : "PENDING", providerRefundTrxId: result.refundTrxId, providerStatus: result.transactionStatus, rawResponse: result.raw as Prisma.InputJsonValue, ...(done ? { providerConfirmedAt: new Date() } : {}) },
    });
    if (done) await recordGatewayRefundInAccounting(saved.id, adminId);
    return saved;
  } catch (error) {
    logServerError("gateway.bkash.refund", error, { refund: refundId });
    if (error instanceof BkashError && !error.outcomeUnknown) {
      // bKash answered and refused: this refund did not happen, so the amount is free again.
      return prisma.gatewayRefund.update({ where: { id: refundId }, data: { status: "FAILED", providerStatus: error.code ?? "REJECTED", rawResponse: { message: error.message } } });
    }
    return prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId } }); // PENDING + submittedAt set = uncertain
  }
}

/**
 * Recovery for a refund that was created but whose request was never sent (the app stopped between saving it and calling bKash).
 * Allowed only when submittedAt is still empty AND the row is old enough that its creating request cannot still be running.
 */
export async function sendNeverSubmittedGatewayRefund(refundId: string, adminId: string) {
  await prisma.$transaction((tx) => assertAdminActor(tx, adminId));
  const refund = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: { select: { orderId: true } } } });
  if (refund.status !== "PENDING") throw new UserFacingError("This refund is already finished.");
  if (refund.submittedAt) throw new UserFacingError("This refund may already have reached bKash, so it cannot be sent again. Check it with bKash or resolve it.");
  if (Date.now() - refund.createdAt.getTime() < 2 * 60 * 1000) throw new UserFacingError("This refund was just created and may still be sending. Wait a couple of minutes.");
  await prisma.$transaction((tx) => recordAudit(tx, { actorId: adminId, action: "GATEWAY_REFUND_RESEND_NEVER_SENT", entityType: "ORDER", entityId: refund.transaction.orderId, detail: { refundId } }));
  return sendRefundToProvider(refundId, adminId);
}

/** A refund must have been "out" at least this long before anyone may attest it: any request still in flight has finished or timed out by then. */
const ATTEST_AFTER_MS = 10 * 60 * 1000;

/** Amount (BDT) from which a manual attestation needs a SECOND, different admin. Unset or 0 = off (a single admin can resolve). */
function approvalThreshold(): number {
  const n = Number(process.env.GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type Attestation = { outcome: "REFUNDED" | "NOT_REFUNDED"; trx: string | null; confirmedOn: Date | null; evidence: string; note: string };

function validateAttestation(refund: { createdAt: Date }, input: { outcome: string; providerRefundTrxId?: string; confirmedOn?: string; evidence?: string; note?: string }): Attestation {
  if (input.outcome !== "REFUNDED" && input.outcome !== "NOT_REFUNDED") throw new UserFacingError("Choose what the bKash dashboard shows.");
  const evidence = input.evidence?.trim() ?? "";
  if (evidence.length < 6) throw new UserFacingError("Enter where you saw this (for example a dashboard screenshot name, support ticket or statement reference).");
  const note = input.note?.trim() ?? "";
  if (note.length < 10) throw new UserFacingError("Describe what you checked in the bKash dashboard (at least a short sentence).");
  if (input.outcome === "NOT_REFUNDED") return { outcome: "NOT_REFUNDED", trx: null, confirmedOn: null, evidence: evidence.slice(0, 200), note: note.slice(0, 500) };
  const trx = input.providerRefundTrxId?.trim().toUpperCase() ?? "";
  if (!/^[A-Z0-9]{6,40}$/.test(trx)) throw new UserFacingError("Enter the bKash refund transaction id shown in the dashboard.");
  const day = input.confirmedOn ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UserFacingError("Enter the date bKash shows for the refund.");
  const when = new Date(`${day}T00:00:00.000Z`);
  const floor = new Date(`${refund.createdAt.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() || when.getTime() < floor.getTime()) throw new UserFacingError("The refund date must be between the day the refund was requested and today.");
  return { outcome: "REFUNDED", trx, confirmedOn: when, evidence: evidence.slice(0, 200), note: note.slice(0, 500) };
}

/** Takes a per-refund lock so propose / approve / reject / resolve can never interleave; released when the transaction ends. */
async function withRefundLock<T>(refundId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gwrefund-resolve:${refundId}`}))`;
    return fn(tx);
  });
}

/** Checks every precondition for ANY manual decision and returns the fresh row. Must run inside the refund lock. */
async function loadAttestable(tx: Prisma.TransactionClient, refundId: string) {
  const refund = await tx.gatewayRefund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: { select: { orderId: true } } } });
  if (refund.status !== "PENDING") throw new UserFacingError("This refund was already settled.");
  if (!refund.submittedAt) throw new UserFacingError("This refund was never sent, so there is nothing to resolve. Send it instead.");
  if (Date.now() - refund.submittedAt.getTime() < ATTEST_AFTER_MS) throw new UserFacingError("This refund was sent less than 10 minutes ago and may still be processing. Check again later.");
  return refund;
}

type RefundRow = Awaited<ReturnType<typeof loadAttestable>>;

/** Applies a validated attestation. Conditional on PENDING, so a concurrent decision makes it fail instead of double-applying. */
async function applyAttestation(tx: Prisma.TransactionClient, refund: RefundRow, att: Attestation, resolverId: string, proposerId: string | null) {
  const data: Prisma.GatewayRefundUpdateManyMutationInput =
    att.outcome === "REFUNDED"
      ? { status: "SUCCEEDED", providerRefundTrxId: att.trx, providerStatus: "CONFIRMED_BY_ADMIN", providerConfirmedAt: att.confirmedOn }
      : { status: "FAILED", providerStatus: "NOT_REFUNDED_CONFIRMED_BY_ADMIN" };
  if (att.outcome === "REFUNDED" && att.trx) {
    const clash = await tx.gatewayRefund.findFirst({ where: { providerRefundTrxId: { equals: att.trx, mode: "insensitive" }, id: { not: refund.id } }, select: { id: true } });
    if (clash) throw new UserFacingError("That refund transaction id is already recorded on another refund.");
  }
  const res = await tx.gatewayRefund.updateMany({
    where: { id: refund.id, status: "PENDING" },
    data: { ...data, resolvedAt: new Date(), resolvedById: resolverId, resolutionNote: att.note, resolutionEvidence: att.evidence, proposedOutcome: null, proposedTrxId: null, proposedConfirmedOn: null, proposedEvidence: null, proposedNote: null, proposedById: null, proposedAt: null },
  });
  if (res.count !== 1) throw new UserFacingError("This refund was just settled by someone else.");
  await recordAudit(tx, {
    actorId: resolverId,
    action: "GATEWAY_REFUND_RESOLVED",
    entityType: "ORDER",
    entityId: refund.transaction.orderId,
    detail: { refundId: refund.id, outcome: att.outcome, evidence: att.evidence, trx: att.trx, proposedBy: proposerId, note: att.note.slice(0, 200) },
  });
}

/**
 * Settles an UNCERTAIN refund (the request may have reached bKash, no answer recorded). bKash is asked first (when it can be);
 * only if it gives no answer may an admin attest what the bKash dashboard shows, with an evidence reference and a note.
 * Nothing is ever resent. Above the optional approval threshold the attestation is only PROPOSED here and a DIFFERENT admin must approve it.
 */
export async function resolveUncertainGatewayRefund(args: { refundId: string; adminId: string; outcome: "REFUNDED" | "NOT_REFUNDED"; providerRefundTrxId?: string; confirmedOn?: string; evidence?: string; note: string }): Promise<{ refund: Awaited<ReturnType<typeof prisma.gatewayRefund.findUniqueOrThrow>>; awaitingApproval: boolean }> {
  await prisma.$transaction((tx) => assertAdminActor(tx, args.adminId));
  const first = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: args.refundId } });
  if (first.status !== "PENDING") return { refund: first, awaitingApproval: false };

  // bKash first (skipped only when bKash is not configured at all, so manual resolution stays possible).
  if (first.submittedAt && isBkashUsable(getBkashConfig())) {
    const checked = await syncGatewayRefund(args.refundId, args.adminId);
    if (checked.status !== "PENDING") return { refund: checked, awaitingApproval: false };
  }

  const outcome = await withRefundLock(args.refundId, async (tx) => {
    await assertAdminActor(tx, args.adminId);
    const refund = await loadAttestable(tx, args.refundId);
    if (refund.proposedById) throw new UserFacingError("A decision for this refund is already waiting for a second admin's approval.");
    const att = validateAttestation(refund, args);
    const threshold = approvalThreshold();
    if (threshold > 0 && Number(refund.amount) >= threshold) {
      const res = await tx.gatewayRefund.updateMany({
        where: { id: refund.id, status: "PENDING", proposedById: null },
        data: { proposedOutcome: att.outcome, proposedTrxId: att.trx, proposedConfirmedOn: att.confirmedOn, proposedEvidence: att.evidence, proposedNote: att.note, proposedById: args.adminId, proposedAt: new Date() },
      });
      if (res.count !== 1) throw new UserFacingError("This refund was just changed by someone else.");
      await recordAudit(tx, { actorId: args.adminId, action: "GATEWAY_REFUND_ATTEST_PROPOSED", entityType: "ORDER", entityId: refund.transaction.orderId, detail: { refundId: refund.id, outcome: att.outcome, evidence: att.evidence, trx: att.trx } });
      return { awaiting: true as const, refund };
    }
    await applyAttestation(tx, refund, att, args.adminId, null);
    return { awaiting: false as const, refund };
  });

  const saved = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: args.refundId } });
  if (!outcome.awaiting && saved.status === "SUCCEEDED") await recordGatewayRefundInAccounting(saved.id, args.adminId);
  return { refund: saved, awaitingApproval: outcome.awaiting };
}

/** A DIFFERENT admin confirms a proposed attestation exactly as proposed (bKash is asked again first). */
export async function approveRefundAttestation(refundId: string, adminId: string) {
  await prisma.$transaction((tx) => assertAdminActor(tx, adminId));
  if (isBkashUsable(getBkashConfig())) {
    const pre = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId } });
    if (pre.status === "PENDING" && pre.submittedAt) {
      const checked = await syncGatewayRefund(refundId, adminId);
      if (checked.status !== "PENDING") return checked;
    }
  }
  await withRefundLock(refundId, async (tx) => {
    await assertAdminActor(tx, adminId);
    const refund = await loadAttestable(tx, refundId);
    if (!refund.proposedById || !refund.proposedOutcome) throw new UserFacingError("There is no decision waiting for approval.");
    if (refund.proposedById === adminId) throw new UserFacingError("A different admin must approve this decision.");
    const att: Attestation = {
      outcome: refund.proposedOutcome as Attestation["outcome"],
      trx: refund.proposedTrxId,
      confirmedOn: refund.proposedConfirmedOn,
      evidence: refund.proposedEvidence ?? "",
      note: refund.proposedNote ?? "",
    };
    await applyAttestation(tx, refund, att, adminId, refund.proposedById);
  });
  const saved = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId } });
  if (saved.status === "SUCCEEDED") await recordGatewayRefundInAccounting(saved.id, adminId);
  return saved;
}

/** Withdraws or rejects a proposal (the proposer or any other admin). The refund stays uncertain. */
export async function rejectRefundAttestation(refundId: string, adminId: string, reason: string) {
  await prisma.$transaction((tx) => assertAdminActor(tx, adminId));
  const why = reason?.trim() ?? "";
  if (why.length < 5) throw new UserFacingError("Say why the decision is being rejected.");
  await withRefundLock(refundId, async (tx) => {
    const refund = await tx.gatewayRefund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: { select: { orderId: true } } } });
    if (refund.status !== "PENDING" || !refund.proposedById) throw new UserFacingError("There is no decision waiting for approval.");
    await tx.gatewayRefund.updateMany({
      where: { id: refundId, status: "PENDING", proposedById: { not: null } },
      data: { proposedOutcome: null, proposedTrxId: null, proposedConfirmedOn: null, proposedEvidence: null, proposedNote: null, proposedById: null, proposedAt: null },
    });
    await recordAudit(tx, { actorId: adminId, action: "GATEWAY_REFUND_ATTEST_REJECTED", entityType: "ORDER", entityId: refund.transaction.orderId, detail: { refundId, proposedBy: refund.proposedById, outcome: refund.proposedOutcome, reason: why.slice(0, 200) } });
  });
  return prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId } });
}

/** Asks bKash what happened to a refund that is still PENDING. */
export async function syncGatewayRefund(refundId: string, adminId: string) {
  await prisma.$transaction((tx) => assertAdminActor(tx, adminId));
  const config = getBkashConfig();
  if (!isBkashUsable(config)) throw new UserFacingError("bKash is not configured.");
  const refund = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: true } });
  if (refund.status !== "PENDING") return refund;
  if (!refund.submittedAt) throw new UserFacingError("This refund was never sent to bKash, so there is nothing to check. Send it instead.");
  try {
    const result = await bkashRefundStatus(config, { paymentId: refund.transaction.providerPaymentId as string, trxId: refund.transaction.providerTrxId as string });
    if ((result.transactionStatus ?? "").toLowerCase() === "completed") {
      const saved = await prisma.gatewayRefund.update({ where: { id: refundId }, data: { status: "SUCCEEDED", providerRefundTrxId: result.refundTrxId ?? refund.providerRefundTrxId, providerStatus: result.transactionStatus, rawResponse: result.raw as Prisma.InputJsonValue, providerConfirmedAt: refund.providerConfirmedAt ?? new Date() } });
      await recordGatewayRefundInAccounting(saved.id, adminId);
      return saved;
    }
  } catch (error) {
    logServerError("gateway.bkash.refund_sync", error, { refund: refundId });
  }
  return refund; // not confirmed: still pending (never assumed done)
}


/**
 * A verified bKash notification. Its text is untrusted: it is only used to find which open attempt it names (by bKash payment id),
 * and that attempt is then QUERIED at bKash. Messages that name nothing we know are ignored.
 */
export async function handleBkashNotification(message: string): Promise<void> {
  let inner: unknown;
  try {
    inner = JSON.parse(message);
  } catch {
    return;
  }
  if (!inner || typeof inner !== "object") return;
  const record = inner as Record<string, unknown>;
  const raw = record.paymentID ?? record.paymentId ?? record.payment_id;
  const paymentId = typeof raw === "string" && /^[A-Za-z0-9_-]{4,100}$/.test(raw) ? raw : null;
  if (!paymentId) return;
  const txn = await prisma.gatewayTransaction.findUnique({ where: { providerPaymentId: paymentId }, select: { id: true } });
  if (txn) await verifyGatewayTransaction(txn.id, { allowExecute: false });
}

/** Admin recovery: re-check every attempt that is past its time limit (or never reached bKash), at most `limit` per run. */
export async function recoverStuckGatewayTransactions(adminId: string, limit = 25): Promise<{ totalStuck: number; settled: number; stillOpen: number; failed: number; notReached: number; lateCompleted: number }> {
  await prisma.$transaction((tx) => assertAdminActor(tx, adminId));
  const stuck = await prisma.gatewayTransaction.findMany({
    where: { OR: [{ status: { in: ["PENDING_APPROVAL", "VERIFYING"] }, expiresAt: { lt: new Date() } }, { status: "INITIATED", createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) } }] },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 50),
    select: { id: true },
  });
  const totalStuck = await prisma.gatewayTransaction.count({
    where: { OR: [{ status: { in: ["PENDING_APPROVAL", "VERIFYING"] }, expiresAt: { lt: new Date() } }, { status: "INITIATED", createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) } }] },
  });
  let settled = 0;
  let stillOpen = 0;
  let failed = 0;
  let processed = 0;
  // Resumable: each attempt is claimed and settled on its own, so a run cut short by this time budget is simply run again.
  const deadline = Date.now() + 45_000;
  for (const t of stuck) {
    if (Date.now() > deadline) break;
    processed++;
    try {
      const r = await verifyGatewayTransaction(t.id, { allowExecute: false });
      if ((TERMINAL as readonly string[]).includes(r.status)) settled++;
      else stillOpen++;
    } catch (error) {
      failed++;
      logServerError("gateway.recover", error, { txn: t.id });
    }
  }

  // Attempts we already closed (failed / cancelled / expired) are asked about once more: if bKash says one actually completed,
  // it is NOT credited automatically (the customer may have been told it failed): it goes to "needs review" for a person.
  let lateCompleted = 0;
  const config = getBkashConfig();
  if (isBkashUsable(config)) {
    const closed = await prisma.gatewayTransaction.findMany({
      where: { status: { in: ["FAILED", "EXPIRED", "CANCELLED"] }, providerPaymentId: { not: null }, updatedAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, providerPaymentId: true },
    });
    for (const t of closed) {
      if (Date.now() > deadline) break;
      try {
        const state = await bkashQueryPayment(config, t.providerPaymentId as string);
        if (statusFromProvider(state) !== "COMPLETED") continue;
        const moved = await prisma.gatewayTransaction.updateMany({
          where: { id: t.id, status: { in: ["FAILED", "EXPIRED", "CANCELLED"] } },
          data: { status: "NEEDS_REVIEW", providerTrxId: state.trxId, providerStatus: state.transactionStatus, providerStatusCode: state.statusCode, rawVerify: state.raw as Prisma.InputJsonValue, failureReason: "bKash reports this payment as completed although it was closed here. Check the order before crediting or refunding." },
        });
        lateCompleted += moved.count;
      } catch (error) {
        logServerError("gateway.recover.closed", error, { txn: t.id });
      }
    }
  }
  await prisma.$transaction((tx) => recordAudit(tx, { actorId: adminId, action: "GATEWAY_RECOVER", entityType: "GATEWAY", entityId: "bkash", detail: { totalStuck, settled, stillOpen, failed, lateCompleted } }));
  // Anything not reached (time budget or batch size) was NOT checked and is NOT failed: it is still listed as stuck.
  return { totalStuck, settled, stillOpen, failed, notReached: Math.max(totalStuck - processed, 0), lateCompleted };
}

/**
 * Records a CONFIRMED gateway refund in the existing refund accounting (one REFUND financial record, keyed by the refund's id so it can
 * never be written twice). If the accounting rules refuse it (for example the order was already refunded by hand), the refund stays
 * confirmed at bKash with no accounting link and shows up in reconciliation instead of being recorded twice.
 */
export async function recordGatewayRefundInAccounting(refundId: string, adminId: string, opts: { acknowledgeExistingRefunds?: boolean } = {}): Promise<{ recorded: boolean; message?: string }> {
  const refund = await prisma.gatewayRefund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: { select: { orderId: true, order: { select: { orderNumber: true } } } } } });
  if (refund.status !== "SUCCEEDED") return { recorded: false, message: "Only a refund confirmed by bKash is recorded in accounting." };
  if (refund.incidentId) return { recorded: true };
  if (!opts.acknowledgeExistingRefunds) {
    // A refund entered by hand for this order may be THIS refund. Writing a second record would count the same money twice,
    // so automatic recording stops here and an admin decides (the retry button asks them to confirm).
    const manual = await prisma.financialIncident.aggregate({
      where: { orderId: refund.transaction.orderId, kind: "REFUND", OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "gwrefund:" } } }] },
      _sum: { refundAmount: true },
    });
    if (Number(manual._sum.refundAmount ?? 0) > 0) {
      return { recorded: false, message: "This order already has a refund recorded in accounting by hand. Check it before recording this one, so the same money is not counted twice." };
    }
  }
  try {
    const { id } = await recordIncident(
      {
        kind: "REFUND",
        // The accounting date is when the refund was CONFIRMED, never when this (possibly much later) retry runs.
        occurredOn: (refund.providerConfirmedAt ?? refund.updatedAt).toISOString().slice(0, 10),
        orderId: refund.transaction.orderId,
        quantity: 0,
        stockEffect: "NONE",
        lossAmount: 0,
        refundAmount: Number(refund.amount),
        courierFee: 0,
        note: `bKash refund${refund.providerRefundTrxId ? ` ${refund.providerRefundTrxId}` : ""} for order ${refund.transaction.order.orderNumber}`,
        idempotencyKey: `gwrefund:${refund.id}`,
      },
      adminId,
    );
    await prisma.gatewayRefund.update({ where: { id: refund.id }, data: { incidentId: id, accountingRecordedAt: new Date() } });
    return { recorded: true };
  } catch (error) {
    logServerError("gateway.refund.accounting", error, { refund: refund.id });
    return { recorded: false, message: error instanceof UserFacingError ? error.message : "Could not record the refund in accounting." };
  }
}
