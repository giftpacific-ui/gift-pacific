import { assertDispatchReady, assertServiceActor, type ServiceActor } from "@/server/services/advance.service";
import { notifyUser } from "@/server/services/notification.service";
import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { getCourierConfig, buildTrackingUrl, type CourierConfig } from "@/lib/courier/config";
import { getCourierProvider, getCourierProviderByKey } from "@/lib/courier";
import { isSupportedCourierKey, usableCourierProviders } from "@/lib/courier/registry";
import { COURIER_EVENT_LABEL, checkBookingEligibility, planOrderTransitions, recipientFromSnapshot, sanitizeProviderMessage, verifyBearerSecret, type BookingOrderView, STALE_BOOKING_MS } from "@/lib/courier/status";
import type { CourierProvider } from "@/lib/courier/types";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { outstandingProcurementForOrder } from "@/server/services/order-inventory";
import { isSafeHttpUrl } from "@/lib/url-safety";
import { utf8ByteLength } from "@/lib/bounded-body";
import { logServerWarning } from "@/lib/logger";
import type { OrderStatus } from "@prisma/client";

/**
 * Courier operations. Hard rules enforced here:
 *  - Booking is a delivery operation: it NEVER changes order status or stock.
 *  - Only the transitions allowed by lib/order-transitions.ts are ever applied,
 *    and courier events can never produce CANCELLED/REFUNDED (the stock-moving
 *    statuses) — see lib/courier/status.ts.
 *  - Booking is claimed with a conditional UPDATE before the network call, so
 *    repeated clicks / concurrent requests can't create duplicate consignments.
 *  - Provider calls happen outside any DB transaction, server-side only.
 */

const bookingSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  total: true,
  phone: true,
  shippingSnapshot: true,
  customerNote: true,
  courierBookingStatus: true,
  courierBookingStartedAt: true,
  courierConsignmentId: true,
  courierProvider: true,
  items: { select: { productName: true, variantName: true, quantity: true } },
} as const;

type Deps = { provider?: CourierProvider | null; config?: CourierConfig; now?: () => Date };

/** `key` selects a specific courier (its own configuration); without it the default courier is used, as before. Injected deps win (tests). */
function resolve(deps: Deps, key?: string | null) {
  const now = deps.now ?? (() => new Date());
  if (key && deps.config === undefined && deps.provider === undefined) {
    if (!isSupportedCourierKey(key)) {
      return { config: { ...getCourierConfig(), provider: null, problem: `"${key}" is not an available courier.` } as CourierConfig, provider: null, now };
    }
    const picked = getCourierProviderByKey(key);
    return { config: picked.config, provider: picked.provider, now };
  }
  const config = deps.config ?? getCourierConfig();
  const provider = deps.provider === undefined ? getCourierProvider(config) : deps.provider;
  return { config, provider, now };
}

function toView(order: {
  status: OrderStatus;
  paymentMethod: string;
  paymentStatus: string;
  total: unknown;
  advancePaid?: unknown;
  phone: string;
  shippingSnapshot: unknown;
  courierBookingStatus: BookingOrderView["courierBookingStatus"];
  courierBookingStartedAt: Date | null;
}): BookingOrderView {
  return {
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    total: Number(order.total),
    advancePaid: Number(order.advancePaid ?? 0),
    courierBookingStatus: order.courierBookingStatus,
    courierBookingStartedAt: order.courierBookingStartedAt,
    recipient: recipientFromSnapshot(order.shippingSnapshot, order.phone),
  };
}

/** Admin panel data (admin-only; never reaches customers). */
export async function getCourierPanel(orderId: string, deps: Deps = {}) {
  const { config, provider, now } = resolve(deps);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      ...bookingSelect,
      courierName: true,
      trackingNumber: true,
      trackingUrl: true,
      courierBookedAt: true,
      courierLastStatus: true,
      courierLastEventAt: true,
      courierLastError: true,
    },
  });
  if (!order) return null;
  const strict = checkBookingEligibility(toView(order), now());
  const needsConfirmation = !strict.ok && strict.code === "needs_confirmation";
  const usable = deps.provider !== undefined || deps.config !== undefined ? [] : usableCourierProviders();
  return {
    providerName: provider?.displayName ?? null,
    providerProblem: provider || usable.length > 0 ? null : config.problem,
    /** Couriers that can be chosen for this booking (only configured, working ones). Labels only: no credentials. */
    providers: usable.map((p) => ({ key: p.key as string, label: p.label })),
    defaultProvider: provider?.key ?? null,
    canRefresh: Boolean((order.courierProvider ? resolve(deps, order.courierProvider).provider : provider)?.fetchStatus) && order.courierBookingStatus === "BOOKED",
    bookingStatus: order.courierBookingStatus,
    // Bookable now, or bookable once the admin confirms they checked the courier portal.
    canBook: (Boolean(provider) || usable.length > 0) && (strict.ok || needsConfirmation),
    needsConfirmation,
    blockedReason: strict.ok ? null : strict.message,
    consignmentId: order.courierConsignmentId,
    courierName: order.courierName,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    bookedAt: order.courierBookedAt,
    lastStatus: order.courierLastStatus,
    lastEventAt: order.courierLastEventAt,
    lastError: order.courierLastError,
  };
}

export type BookResult = { booked: true; consignmentId: string } | { booked: false; message: string };

/** Books an order with the configured courier. Idempotent: see header comment. */
export async function bookOrderWithCourier(
  orderId: string,
  opts: { actor: ServiceActor; confirmUncertain?: boolean; provider?: string | null },
  deps: Deps = {},
): Promise<BookResult> {
  // Booking creates a real parcel with a real courier: authorise before anything else (even before the "not configured" answer).
  await assertServiceActor(prisma, opts?.actor);
  const { config, provider, now } = resolve(deps, opts.provider);
  if (!provider) throw new UserFacingError(config.problem ?? "Courier booking is not configured.");

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { ...bookingSelect, fulfillmentMode: true } });
  if (!order) throw new UserFacingError("Order not found.");
  // A marketplace that ships the parcel itself must never also be booked with our courier.
  if (order.fulfillmentMode === "MARKETPLACE_FULFILLED") {
    throw new UserFacingError("This order is fulfilled by the marketplace, so it cannot be booked with a courier here.");
  }

  // An unconfirmed booking with one courier must be settled with THAT courier: switching now could create a second parcel elsewhere.
  if (order.courierBookingStatus === "UNCERTAIN" && order.courierProvider && order.courierProvider !== provider.key) {
    throw new UserFacingError(`An earlier booking with ${order.courierProvider} is still unconfirmed. Settle it with ${order.courierProvider} before booking with another courier.`);
  }
  const eligibility = checkBookingEligibility(toView(order), now(), opts);
  if (!eligibility.ok) throw new UserFacingError(eligibility.message);
  // Never book a parcel for an order whose required advance is unverified or whose required review is pending.
  await assertDispatchReady(prisma, orderId);
  // Never book a parcel for goods that have not been sourced yet.
  if ((await outstandingProcurementForOrder(prisma, orderId)) > 0) {
    throw new UserFacingError("Some units of this order are still waiting to be sourced, so it cannot be booked with a courier yet.");
  }

  // Claim the booking. The WHERE pins the exact state we just validated, so
  // of N concurrent clicks exactly one gets count === 1.
  const claim = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: order.status,
      courierBookingStatus: order.courierBookingStatus,
      courierBookingStartedAt: order.courierBookingStartedAt,
    },
    data: {
      courierBookingStatus: "BOOKING",
      courierBookingStartedAt: now(),
      courierProvider: provider.key,
      courierLastError: null,
    },
  });
  if (claim.count !== 1) {
    throw new UserFacingError("This order was just changed or is already being booked. Refresh and check its status.");
  }

  const itemDescription = order.items
    .map((i) => `${i.productName}${i.variantName ? ` (${i.variantName})` : ""} x${i.quantity}`)
    .join(", ")
    .slice(0, 200);

  let result;
  try {
    result = await provider.book({
      reference: order.orderNumber,
      recipientName: eligibility.name,
      recipientPhone: eligibility.phone,
      recipientAddress: eligibility.address,
      codAmount: eligibility.codAmount,
      itemDescription,
      note: order.customerNote ? order.customerNote.slice(0, 200) : undefined,
    });
  } catch {
    result = { ok: false as const, kind: "uncertain" as const, message: "Unexpected error while contacting the courier." };
  }

  if (result.ok) {
    const trackingUrl =
      (result.trackingUrl && isSafeHttpUrl(result.trackingUrl) ? result.trackingUrl : null) ??
      buildTrackingUrl(config, result.trackingCode ?? result.consignmentId);
    const saved = await prisma.order.updateMany({
      where: { id: orderId, courierBookingStatus: "BOOKING" },
      data: {
        courierBookingStatus: "BOOKED",
        courierConsignmentId: result.consignmentId,
        courierName: provider.displayName,
        trackingNumber: result.trackingCode ?? result.consignmentId,
        trackingUrl,
        courierBookedAt: now(),
        courierLastStatus: result.providerStatus ? result.providerStatus.toLowerCase().slice(0, 64) : null,
        courierLastEventAt: now(),
        courierLastError: null,
      },
    });
    if (saved.count === 1) {
      await prisma.orderTrackingEvent.create({
        data: { orderId, status: order.status, note: `Booked with ${provider.displayName} (tracking ${result.trackingCode ?? result.consignmentId}).` },
      });
      // Tell the customer only the real facts (courier name and the tracking code the courier returned). Idempotent per order.
      const owner = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true } });
      await notifyUser(prisma, {
        userId: owner?.userId,
        type: "ORDER",
        title: "Your order was handed to the courier",
        body: `${provider.displayName} will deliver order ${order.orderNumber}. Tracking code: ${result.trackingCode ?? result.consignmentId}.`,
        href: `/account/orders/${order.orderNumber}`,
        dedupeKey: `courier:${orderId}:booked`,
      }).catch(() => undefined);
    }
    return { booked: true, consignmentId: result.consignmentId };
  }

  const message = sanitizeProviderMessage(result.message, [config.apiKey, config.apiSecret]);
  // Operators need to see failed bookings in the logs (order number only — no customer data).
  logServerWarning("courier.book-failed", message, { orderNumber: order.orderNumber, provider: provider.key, outcome: result.kind });
  await prisma.order.updateMany({
    where: { id: orderId, courierBookingStatus: "BOOKING" },
    data: {
      courierBookingStatus: result.kind === "rejected" ? "FAILED" : "UNCERTAIN",
      courierLastError: message,
    },
  });
  return {
    booked: false,
    message:
      result.kind === "rejected"
        ? `The courier rejected the booking: ${message}`
        : `Could not confirm the booking (${message}). It may have gone through — check the courier portal before retrying.`,
  };
}

// ---------------------------------------------------------------------------
// Status updates (webhook + manual refresh share one idempotent path)
// ---------------------------------------------------------------------------

export type StatusApplyResult =
  | { applied: true; steps: OrderStatus[] }
  | { applied: false; reason: "duplicate" | "no_transition" | "not_found" };

/**
 * Records a provider status for an order and walks the order forward through
 * the transitions the policy allows. Idempotent: re-delivering the same
 * status is a no-op (guarded by a conditional UPDATE on courierLastStatus).
 */
export async function applyCourierStatus(
  orderId: string,
  rawStatus: string,
  provider: CourierProvider,
  now: () => Date = () => new Date(),
): Promise<StatusApplyResult> {
  const status = rawStatus.trim().toLowerCase().slice(0, 64);
  if (!status) return { applied: false, reason: "no_transition" };

  // `not` alone would skip rows where courierLastStatus IS NULL (SQL NULL
  // semantics), so NULL is matched explicitly.
  const claim = await prisma.order.updateMany({
    where: { id: orderId, OR: [{ courierLastStatus: null }, { courierLastStatus: { not: status } }] },
    data: { courierLastStatus: status, courierLastEventAt: now() },
  });
    // A repeat of the status we already recorded is NOT blindly ignored: the process may have
  // crashed after recording it but before the order caught up. Recompute what is still
  // pending (each step is individually claim-guarded, so re-running is safe) and apply it;
  // only when nothing is pending is it a true duplicate.
  const isReplay = claim.count !== 1;
  const event = provider.mapStatus(status);
  const current = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!current) return { applied: false, reason: "not_found" };
  const plan = planOrderTransitions(current.status, event);
  if (isReplay && plan.length === 0) return { applied: false, reason: "duplicate" };

  const applied: OrderStatus[] = [];
  for (const step of plan) {
    try {
      await adminUpdateOrderStatus(orderId, step, `Courier update: ${COURIER_EVENT_LABEL[event]}`, { system: "courier-sync" });
      applied.push(step);
    } catch (error) {
      // A step the policy (or a concurrent admin change) refuses just stops
      // the walk; the raw status is already recorded.
      if (error instanceof UserFacingError) break;
      throw error;
    }
  }
  return applied.length > 0 ? { applied: true, steps: applied } : { applied: false, reason: "no_transition" };
}

/** Manual "refresh from courier" for providers with a status endpoint. */
export async function refreshCourierStatus(orderId: string, actor: ServiceActor, deps: Deps = {}): Promise<StatusApplyResult> {
  await assertServiceActor(prisma, actor);
  // Use the courier THIS order was booked with (it may differ from the default).
  const booked = await prisma.order.findUnique({ where: { id: orderId }, select: { courierProvider: true } });
  const { config, provider, now } = resolve(deps, booked?.courierProvider);
  if (!provider?.fetchStatus) {
    throw new UserFacingError(config.problem ?? "This courier doesn't support status refresh. Update the status manually.");
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { courierBookingStatus: true, courierConsignmentId: true, courierProvider: true },
  });
  if (!order || order.courierBookingStatus !== "BOOKED" || !order.courierConsignmentId || order.courierProvider !== provider.key) {
    throw new UserFacingError("This order has no API-booked consignment to refresh.");
  }
  const result = await provider.fetchStatus(order.courierConsignmentId);
  if (!result.ok) throw new UserFacingError(result.message);
  return applyCourierStatus(orderId, result.status, provider, now);
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export const MAX_WEBHOOK_BYTES = 64 * 1024;

export async function handleCourierWebhook(
  input: { authorization: string | null; rawBody: string; provider?: string | null },
  deps: Deps = {},
): Promise<{ status: number; body: { ok: boolean; note?: string } }> {
  const { config, provider, now } = resolve(deps, input.provider);
  // Not configured → behave as if the endpoint doesn't exist.
  if (!provider || !config.webhookSecret) return { status: 404, body: { ok: false } };
  if (!verifyBearerSecret(input.authorization, config.webhookSecret)) return { status: 401, body: { ok: false } };
  // UTF-8 BYTES, not string length (the route also bounds the read itself).
  if (utf8ByteLength(input.rawBody) > MAX_WEBHOOK_BYTES) return { status: 413, body: { ok: false } };

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { ok: false } };
  }
  const parsed = provider.parseWebhook(json);
  if (!parsed || (!parsed.consignmentId && !parsed.reference)) return { status: 200, body: { ok: true, note: "ignored" } };

  let order = parsed.consignmentId
    ? await prisma.order.findFirst({
        where: { courierProvider: provider.key, courierConsignmentId: parsed.consignmentId },
        select: { id: true },
      })
    : null;

  // Booking answer was lost (UNCERTAIN/stale BOOKING) but the provider knows
  // our reference: adopt its consignment id so the order self-heals.
  if (!order && parsed.reference && parsed.consignmentId) {
    const candidate = await prisma.order.findFirst({
      where: { orderNumber: parsed.reference, courierBookingStatus: { in: ["UNCERTAIN", "BOOKING"] } },
      select: { id: true },
    });
    if (candidate) {
      const adopted = await prisma.order.updateMany({
        where: { id: candidate.id, courierBookingStatus: { in: ["UNCERTAIN", "BOOKING"] } },
        data: {
          courierBookingStatus: "BOOKED",
          courierProvider: provider.key,
          courierConsignmentId: parsed.consignmentId,
          courierName: provider.displayName,
          trackingNumber: parsed.consignmentId,
          trackingUrl: buildTrackingUrl(config, parsed.consignmentId),
          courierBookedAt: now(),
          courierLastError: null,
        },
      });
      if (adopted.count === 1) order = candidate;
    }
  }

  if (!order) return { status: 200, body: { ok: true, note: "unknown consignment" } };
  const result = await applyCourierStatus(order.id, parsed.status, provider, now);
  return { status: 200, body: { ok: true, note: result.applied ? "applied" : result.reason } };
}

// ---------------------------------------------------------------------------
// Manual fallback
// ---------------------------------------------------------------------------

/**
 * Manual courier entry (works with no provider configured). Refused while
 * an API booking exists or is in flight, so the stored consignment can't be
 * silently overwritten. Once saved the order is MANUAL, which also blocks a
 * later API booking (the parcel is already with a courier).
 */
export async function saveManualCourier(
  orderId: string,
  data: { courierName?: string; trackingNumber?: string; trackingUrl?: string },
  actor: ServiceActor,
) {
  await assertServiceActor(prisma, actor);
  const courierName = data.courierName?.trim().slice(0, 100) || null;
  const trackingNumber = data.trackingNumber?.trim().slice(0, 100) || null;
  const trackingUrl = data.trackingUrl?.trim() || null;
  if (trackingUrl && (!isSafeHttpUrl(trackingUrl) || trackingUrl.length > 500)) {
    throw new UserFacingError("Tracking URL must be a valid http(s) link.");
  }

  const hasAny = Boolean(courierName || trackingNumber || trackingUrl);
  const res = await prisma.order.updateMany({
    where: { id: orderId, courierBookingStatus: { in: ["NOT_BOOKED", "FAILED", "UNCERTAIN", "MANUAL"] } },
    data: {
      courierName,
      trackingNumber,
      trackingUrl,
      courierBookingStatus: hasAny ? "MANUAL" : "NOT_BOOKED",
      courierLastError: null,
    },
  });
  if (res.count !== 1) {
    throw new UserFacingError("This order is booked through the courier API (or being booked); its details can't be edited by hand.");
  }
}

// ---------------------------------------------------------------------------
// Reconciliation: orders whose local state may disagree with the courier's
// ---------------------------------------------------------------------------
export const SILENT_SHIPMENT_MS = 3 * 24 * 3600 * 1000;

export type CourierAttentionReason = "uncertain" | "stale_booking" | "silent_shipment" | "failed";

/**
 * Orders an admin should look at: a booking whose outcome is unknown (UNCERTAIN), a booking
 * claim that never finished (stale BOOKING), a shipment that has been in transit but heard
 * nothing from the courier for days, or a booking that failed. Read-only; the admin acts per
 * order with the existing "check courier" / manual-entry tools. No background job, no queue.
 */
export async function listCourierAttention(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_BOOKING_MS);
  const silentBefore = new Date(now.getTime() - SILENT_SHIPMENT_MS);
  const rows = await prisma.order.findMany({
    where: {
      OR: [
        { courierBookingStatus: "UNCERTAIN" },
        { courierBookingStatus: "FAILED", status: { in: ["CONFIRMED", "PROCESSING"] } },
        { courierBookingStatus: "BOOKING", courierBookingStartedAt: { lt: staleBefore } },
        {
          courierBookingStatus: "BOOKED",
          status: { in: ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] },
          OR: [{ courierLastEventAt: { lt: silentBefore } }, { courierLastEventAt: null, courierBookedAt: { lt: silentBefore } }],
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: 200,
    select: {
      id: true, orderNumber: true, status: true, courierBookingStatus: true, courierConsignmentId: true,
      courierLastStatus: true, courierLastEventAt: true, courierBookedAt: true, courierLastError: true,
    },
  });
  return rows.map((o) => ({
    ...o,
    reason: (o.courierBookingStatus === "UNCERTAIN" ? "uncertain"
      : o.courierBookingStatus === "BOOKING" ? "stale_booking"
      : o.courierBookingStatus === "FAILED" ? "failed" : "silent_shipment") as CourierAttentionReason,
  }));
}

// ---------------------------------------------------------------------------
// Scheduled reconciliation (called by /api/courier/reconcile from an external scheduler)
// ---------------------------------------------------------------------------

export type ReconcileSummary = { polled: number; updated: number; pollFailed: number; autoBooked: number; autoBookSkipped: number };

/**
 * Bounded, sequential, idempotent maintenance pass:
 *  1. polls the provider for in-flight API-booked consignments (webhooks can be missed), applying the same
 *     status mapping/transition rules as the webhook and the manual "refresh" button;
 *  2. ONLY when COURIER_AUTO_BOOK=true (off by default — enable after a verified live test), books CONFIRMED,
 *     never-booked orders through bookOrderWithCourier(), whose conditional claim makes duplicates impossible.
 * Uncertain/failed outcomes are left in place and surface on the admin Courier page; nothing is retried blindly.
 */
export async function reconcileCourier(opts: { pollLimit?: number; bookLimit?: number; autoBook?: boolean } = {}, deps: Deps = {}): Promise<ReconcileSummary> {
  const { provider } = resolve(deps);
  const out: ReconcileSummary = { polled: 0, updated: 0, pollFailed: 0, autoBooked: 0, autoBookSkipped: 0 };
  // Orders are polled through the courier each was BOOKED with (not just the default one). Injected deps (tests) keep the single-provider behaviour.
  const keys = deps.provider !== undefined || deps.config !== undefined ? (provider ? [provider.key] : []) : usableCourierProviders().map((p) => p.key as string);
  if (keys.length === 0) return out; // no courier usable: manual operation only

  {
    const due = await prisma.order.findMany({
      where: {
        courierBookingStatus: "BOOKED", courierProvider: { in: keys }, courierConsignmentId: { not: null },
        status: { in: ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] },
      },
      orderBy: [{ courierLastEventAt: { sort: "asc", nulls: "first" } }, { courierBookedAt: "asc" }],
      take: Math.min(Math.max(opts.pollLimit ?? 25, 1), 100),
      select: { id: true },
    });
    for (const { id } of due) {
      out.polled++;
      try {
        const r = await refreshCourierStatus(id, { system: "courier-reconcile" }, deps);
        if (r.applied) out.updated++;
      } catch (error) {
        out.pollFailed++;
        logServerWarning("courier.reconcile.poll", error instanceof Error ? error.message : "error", { orderId: id });
      }
    }
  }

  if (opts.autoBook) {
    const candidates = await prisma.order.findMany({
      where: { status: "CONFIRMED", courierBookingStatus: "NOT_BOOKED", fulfillmentMode: { not: "MARKETPLACE_FULFILLED" } },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(opts.bookLimit ?? 10, 1), 50),
      select: { id: true },
    });
    for (const { id } of candidates) {
      try {
        await bookOrderWithCourier(id, { actor: { system: "courier-reconcile" } }, deps);
        out.autoBooked++;
      } catch (error) {
        out.autoBookSkipped++; // ineligible / rejected / uncertain: visible on the Courier page, never auto-retried here
        logServerWarning("courier.reconcile.book", error instanceof Error ? error.message : "error", { orderId: id });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bulk booking
// ---------------------------------------------------------------------------

export const BULK_BOOKING_LIMIT = 25;

/** Orders an admin can try to book in bulk: confirmed/processing, not yet booked (or a clean failure), not marketplace-shipped. */
export async function listBulkBookable(limit = 100) {
  return prisma.order.findMany({
    where: {
      status: { in: ["CONFIRMED", "PROCESSING"] },
      courierBookingStatus: { in: ["NOT_BOOKED", "FAILED"] },
      fulfillmentMode: { not: "MARKETPLACE_FULFILLED" },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, orderNumber: true, status: true, total: true, advancePaid: true, paymentMethod: true, courierBookingStatus: true, courierLastError: true, createdAt: true, phone: true },
  });
}

/**
 * booked  = a courier booking was created.
 * failed  = the courier or the system rejected it (nothing was booked).
 * skipped = not eligible / already handled; nothing was attempted against the courier.
 * pending = NOT attempted yet (time or batch limit); it is not a failure and stays selectable.
 */
export type BulkBookingResult = { orderId: string; orderNumber: string; status: "booked" | "failed" | "skipped" | "pending"; message: string };

/** Stop STARTING new bookings after this long, so one request stays within typical server time limits. */
const BULK_BUDGET_MS = 45_000;

/**
 * Books each order through the normal single-order path (so every eligibility rule, the advance/trust/procurement gates
 * and the duplicate-booking claim all apply). Orders run one at a time; one failure never affects the others.
 * RESUMABLE by design: each order's claim and outcome are saved by the booking itself, so a run that is cut off (or a
 * double click, or two admins at once) can simply be run again: booked orders drop out of the list, in-flight orders
 * are refused by the claim, and orders not reached are reported and stay NOT_BOOKED.
 * UNCERTAIN orders are never retried here: they need the explicit confirmation on the order page.
 */
export async function bulkBookOrders(orderIds: string[], deps: Deps = {}, opts: { actor: ServiceActor; provider?: string | null; budgetMs?: number }): Promise<BulkBookingResult[]> {
  await assertServiceActor(prisma, opts?.actor);
  const unique = [...new Set(orderIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const ids = unique.slice(0, BULK_BOOKING_LIMIT);
  const labels = await prisma.order.findMany({ where: { id: { in: unique } }, select: { id: true, orderNumber: true } });
  const numberOf = new Map(labels.map((o) => [o.id, o.orderNumber]));
  const deadline = Date.now() + (opts.budgetMs ?? BULK_BUDGET_MS);
  const results: BulkBookingResult[] = [];
  // Over the per-run size: reported as pending (not failed) so nothing is silently dropped.
  for (const orderId of unique.slice(BULK_BOOKING_LIMIT)) {
    results.push({ orderId, orderNumber: numberOf.get(orderId) ?? orderId, status: "pending", message: `Not attempted (more than ${BULK_BOOKING_LIMIT} selected). Run again to continue.` });
  }
  for (const orderId of ids) {
    const orderNumber = numberOf.get(orderId) ?? orderId;
    if (Date.now() > deadline) {
      results.push({ orderId, orderNumber, status: "pending", message: "Not attempted (time limit reached). Select it again to continue." });
      continue;
    }
    try {
      const r = await bookOrderWithCourier(orderId, { actor: opts.actor, confirmUncertain: false, provider: opts.provider }, deps);
      results.push(r.booked ? { orderId, orderNumber, status: "booked", message: `Booked (${r.consignmentId})` } : { orderId, orderNumber, status: "failed", message: r.message });
    } catch (error) {
      // A refusal by our own rules (not eligible, already booked/in progress, courier unavailable) never reached the courier.
      if (error instanceof UserFacingError) results.push({ orderId, orderNumber, status: "skipped", message: error.message });
      else results.push({ orderId, orderNumber, status: "failed", message: "Unexpected error while booking. Check the order before trying again." });
    }
  }
  return results;
}
