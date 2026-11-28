import { assertDispatchReady, assertServiceActor, dispatchBlockedReason, type ServiceActor } from "@/server/services/advance.service";
import { notifyUser } from "@/server/services/notification.service";
import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { getCourierConfig, getCourierProviderConfig, buildTrackingUrl, describeDefaultCourier, isCourierSwitchedOff, isCourierUsable, type CourierConfig, type DefaultCourierChoice, type SupportedCourier } from "@/lib/courier/config";
import { getCourierProvider, getCourierProviderByKey, statusMapperFor } from "@/lib/courier";
import { COURIER_PROVIDERS, getCourierProviderStatuses, isSupportedCourierKey, usableCourierProviders } from "@/lib/courier/registry";
import { COURIER_STATE_LABEL, courierChoiceView, credentialFingerprint, deriveProviderState, type CourierChoiceView, type CourierProviderState, type CourierStateReason } from "@/lib/courier/provider-state";
import { buildShipmentTimeline, type TimelineRow } from "@/lib/courier/timeline";
import { getStoredConnectionChecks, recordConnectionCheck } from "@/server/services/courier-connection.service";
import { COURIER_EVENT_LABEL, checkBookingEligibility, planOrderTransitions, recipientFromSnapshot, sanitizeProviderMessage, verifyBearerSecret, type BookingOrderView, STALE_BOOKING_MS } from "@/lib/courier/status";
import { computeBookingReadiness, decideEventPrecedence, eventDedupeKey } from "@/lib/courier/sync-rules";
import { expectedCourierCod } from "@/lib/courier/cod-reconciliation";
import type { CourierBookingResult, CourierEvent, CourierProvider, ParsedWebhook } from "@/lib/courier/types";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { outstandingProcurementForOrder } from "@/server/services/order-inventory";
import { codStateForOrder } from "@/server/services/courier-cod.service";
import { isSafeHttpUrl } from "@/lib/url-safety";
import { utf8ByteLength } from "@/lib/bounded-body";
import { logServerError, logServerInfo, logServerWarning } from "@/lib/logger";
import type { OrderStatus, Prisma } from "@prisma/client";

/**
 * Courier operations. Hard rules enforced here:
 *  - Booking is a delivery operation: it NEVER changes order status, stock or any payment record.
 *  - Only the transitions allowed by lib/order-transitions.ts are ever applied,
 *    and courier events can never produce CANCELLED/REFUNDED (the stock-moving
 *    statuses) — see lib/courier/status.ts.
 *  - A courier-driven DELIVERED never records COD cash as collected (see adminUpdateOrderStatus): the courier's word about the parcel
 *    is not evidence of money; staff confirm the cash in courier-cod.service.ts.
 *  - Booking is claimed with a conditional UPDATE before the network call, so
 *    repeated clicks / concurrent requests can't create duplicate consignments.
 *  - An UNCERTAIN booking is never retried blindly: the provider is asked first (when it supports that), and a provider that confirms the
 *    parcel exists permanently blocks a re-booking.
 *  - Provider calls happen outside any DB transaction, server-side only. A provider failure touches only courier columns.
 *  - A rejection of a RETRY never erases the doubt left by the earlier attempt: an order that was UNCERTAIN stays UNCERTAIN.
 *  - One consignment id belongs to exactly one order (checked before every write, and by a partial unique index in the database).
 *  - Every booking outcome (created / rejected / unconfirmed), every hand entry and every courier status lands on the order's shipment
 *    timeline, so an admin can always see what happened and in what order.
 *  - Providers are independent: one courier's failure, timeout or missing adapter never prevents another from being listed, tested or booked.
 */

const bookingSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  total: true,
  // The verified advance already received: the courier collects only the rest. (P5 fix: this was missing, so every booking was priced
  // as if no advance had been paid.)
  advancePaid: true,
  phone: true,
  shippingSnapshot: true,
  customerNote: true,
  courierBookingStatus: true,
  courierBookingStartedAt: true,
  courierConsignmentId: true,
  courierProvider: true,
  courierRemoteConfirmedAt: true,
  items: { select: { productName: true, variantName: true, quantity: true } },
} as const;

type ProviderBinding = { config: CourierConfig; provider: CourierProvider | null };
/**
 * `provider` / `config` inject ONE courier (tests); `byKey` injects several, each answering only for its own key, so multi-courier behaviour
 * (isolation, cross-courier duplicate guards) can be exercised without a second real adapter.
 */
type Deps = {
  provider?: CourierProvider | null; config?: CourierConfig; now?: () => Date; byKey?: Record<string, ProviderBinding>;
  /** Environment to read courier configuration from (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Upper bound for one provider's connection check (tests); defaults to twice the provider timeout plus two seconds. */
  checkTimeoutMs?: number;
};

/** `key` selects a specific courier (its own configuration); without it the default courier is used, as before. Injected deps win (tests). */
function resolve(deps: Deps, key?: string | null) {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  if (key && deps.byKey?.[key]) return { ...deps.byKey[key], now };
  if (key && deps.config === undefined && deps.provider === undefined) {
    if (!isSupportedCourierKey(key)) {
      const known = COURIER_PROVIDERS.find((p) => p.key === key);
      const problem = known
        ? `${known.label} has no API adapter in this app, so it cannot be booked automatically. Record the booking by hand.`
        : `"${key}" is not an available courier.`;
      return { config: { ...getCourierConfig(env), provider: null, problem } as CourierConfig, provider: null, now };
    }
    const picked = getCourierProviderByKey(key, env);
    return { config: picked.config, provider: picked.provider, now };
  }
  const config = deps.config ?? getCourierConfig(env);
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

const cents = (n: number) => Math.round(n * 100);
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/** Display name of a courier key for admin-facing text. Unknown keys are shown as they are (never hidden). */
export const courierLabel = (key: string): string => COURIER_PROVIDERS.find((p) => p.key === key)?.label ?? (key === "manual" ? "Manual entry" : key);

/**
 * Appends one line to the order's shipment timeline (an append-only table). Best effort BY DESIGN: the booking outcome it describes is
 * already stored on the order, so a failure to log must never turn a booked / failed order into an error. `note` is sanitised and bounded;
 * it must never carry customer data (callers pass only provider messages and fixed wording).
 */
async function logShipmentEvent(e: {
  orderId: string; provider: string; source: "BOOKING" | "BOOKING_FAILED" | "BOOKING_UNCERTAIN" | "MANUAL" | "RECOVERY";
  rawStatus: string; consignmentId?: string | null; mappedEvent?: string; note?: string | null; secrets?: (string | null)[];
}): Promise<void> {
  try {
    await prisma.courierShipmentEvent.create({
      data: {
        orderId: e.orderId, provider: e.provider, consignmentId: e.consignmentId ?? null, source: e.source,
        rawStatus: e.rawStatus.toLowerCase().slice(0, 64), mappedEvent: e.mappedEvent ?? "UNKNOWN", outcome: "RECORDED",
        note: e.note ? sanitizeProviderMessage(e.note, e.secrets ?? []) : null,
      },
    });
  } catch (error) {
    logServerError("courier.event-log", error, { source: e.source });
  }
}

/** The order (if any) that already holds this consignment id with this courier. One parcel can belong to one order only. */
async function findConsignmentHolder(provider: string, consignmentId: string, exceptOrderId: string) {
  return prisma.order.findFirst({
    where: { courierProvider: provider, courierConsignmentId: consignmentId, id: { not: exceptOrderId } },
    select: { id: true, orderNumber: true },
  });
}

/** Rejects after `ms`. The wrapped promise keeps running if it never settles, but it can no longer hold anything else up. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolveValue(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Per-order lease: keeps two scheduled runs (or a run and a recovery) off the same order. It expires by itself, so a crashed run
// can never leave an order locked, and a failed poll uses it as a short back-off.
// ---------------------------------------------------------------------------
export const SYNC_LEASE_MS = 2 * 60 * 1000;
export const FAILURE_BACKOFF_MS = 15 * 60 * 1000;
/** An order synchronised within this window is not polled again by the scheduled job (the webhook or an admin can still refresh it). */
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;

async function withLease<T>(orderId: string, now: Date, fn: () => Promise<T>): Promise<{ leased: false } | { leased: true; value: T }> {
  const until = new Date(now.getTime() + SYNC_LEASE_MS);
  const claim = await prisma.order.updateMany({
    where: { id: orderId, OR: [{ courierSyncLeaseUntil: null }, { courierSyncLeaseUntil: { lt: now } }] },
    data: { courierSyncLeaseUntil: until },
  });
  if (claim.count !== 1) return { leased: false };
  try {
    return { leased: true, value: await fn() };
  } finally {
    // Released only if it is still OUR lease (a failure back-off set inside fn is left in place).
    await prisma.order.updateMany({ where: { id: orderId, courierSyncLeaseUntil: until }, data: { courierSyncLeaseUntil: null } }).catch(() => undefined);
  }
}

/** Admin panel data (admin-only; never reaches customers). */
export async function getCourierPanel(orderId: string, deps: Deps = {}) {
  const { config, provider, now } = resolve(deps);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      ...bookingSelect,
      fulfillmentMode: true,
      courierName: true,
      trackingNumber: true,
      trackingUrl: true,
      courierBookedAt: true,
      courierLastStatus: true,
      courierLastEventAt: true,
      courierLastError: true,
      courierLastSyncAt: true,
      courierCodAmount: true,
      advanceRequired: true,
      advanceWaivedById: true,
      trustReviewRequired: true,
      trustReviewedAt: true,
      riskReviewRequired: true,
      riskLevel: true,
      riskReviewDecision: true,
      riskReviewedLevel: true,
      shipmentEvents: { orderBy: { createdAt: "desc" }, take: 50, select: { id: true, provider: true, consignmentId: true, source: true, rawStatus: true, mappedEvent: true, outcome: true, note: true, providerEventAt: true, createdAt: true } },
    },
  });
  if (!order) return null;
  const view = toView(order);
  const strict = checkBookingEligibility(view, now());
  const env = deps.env ?? process.env;
  const injected = deps.provider !== undefined || deps.config !== undefined;
  const usable = injected ? [] : usableCourierProviders(env);
  const apiAvailable = Boolean(provider) || usable.length > 0;
  // Every reason the order cannot be booked (not just the first), from the SAME rules the booking itself enforces.
  const readiness = computeBookingReadiness({
    eligibility: strict,
    gateReason: dispatchBlockedReason(order),
    procurementOutstanding: await outstandingProcurementForOrder(prisma, orderId),
    marketplaceFulfilled: order.fulfillmentMode === "MARKETPLACE_FULFILLED",
    apiAvailable,
    apiProblem: config.problem,
    remoteConfirmed: Boolean(order.courierRemoteConfirmedAt) && order.courierBookingStatus === "UNCERTAIN",
  });
  const blockers = readiness.blockers.filter((b) => b.code !== "provider_unavailable");
  // What the booking WOULD send (shown for review before the one-click action). Available for a retry too.
  const previewEligibility = checkBookingEligibility(view, now(), { confirmUncertain: true });
  const rowProvider = order.courierProvider ? resolve(deps, order.courierProvider).provider : provider;
  const staleBooking = order.courierBookingStatus === "BOOKING" && now().getTime() - (order.courierBookingStartedAt?.getTime() ?? 0) >= STALE_BOOKING_MS;
  // Every courier with its honest state (Pathao / RedX included, as unsupported), and which one "Automatic" means. Labels and flags only.
  const board = await getCourierProviderBoard({ env, now });
  return {
    providerName: provider?.displayName ?? null,
    providerProblem: apiAvailable ? null : config.problem,
    choices: board.providers.map((p) => p.choice),
    /** The courier "Automatic" resolves to, and why (null key = no automatic courier). */
    automatic: { key: board.defaultChoice.key as string | null, message: board.defaultChoice.message },
    defaultProvider: provider?.key ?? null,
    /** The order's own courier, as booked or as entered by hand (null when none). */
    orderProvider: order.courierProvider,
    /** A BOOKING claim that never finished: the courier may or may not hold a parcel. */
    staleBooking,
    canRefresh: Boolean(rowProvider?.fetchStatus) && order.courierBookingStatus === "BOOKED",
    /** An unconfirmed booking can be checked with the courier automatically (reference lookup enabled and supported). */
    canRecover: (order.courierBookingStatus === "UNCERTAIN" || staleBooking) && Boolean(rowProvider?.lookupByReference && rowProvider.features?.referenceLookup),
    bookingStatus: order.courierBookingStatus,
    // Bookable now, or bookable once the admin confirms they checked the courier portal.
    canBook: readiness.canBook,
    needsConfirmation: readiness.needsConfirmation,
    blockedReason: blockers[0]?.message ?? null,
    blockers,
    preview: previewEligibility.ok ? { name: previewEligibility.name, phone: previewEligibility.phone, address: previewEligibility.address, codAmount: previewEligibility.codAmount } : null,
    consignmentId: order.courierConsignmentId,
    courierName: order.courierName,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    bookedAt: order.courierBookedAt,
    lastStatus: order.courierLastStatus,
    lastEventAt: order.courierLastEventAt,
    lastSyncAt: order.courierLastSyncAt,
    lastError: order.courierLastError,
    remoteConfirmedAt: order.courierRemoteConfirmedAt,
    courierCodAmount: order.courierCodAmount == null ? null : Number(order.courierCodAmount),
    timeline: buildShipmentTimeline(order.shipmentEvents as TimelineRow[], courierLabel),
    cod: await codStateForOrder(orderId),
  };
}

export type BookResult = { booked: true; consignmentId: string } | { booked: false; message: string };

const REMOTE_EXISTS = (status: string) =>
  `The courier confirms it already holds a parcel for this order (its status: ${status.replaceAll("_", " ")}). Booking again would create a duplicate. ` +
  `Its details will be filled in by the courier's next status notification, or enter them by hand.`;

/** Records that the provider positively confirmed a parcel exists for an UNCERTAIN / stale-BOOKING order. Never books, never invents ids. */
async function markRemoteConfirmed(orderId: string, provider: CourierProvider, status: string, now: Date, source: "RECOVERY" | "BOOKING-CHECK" = "RECOVERY") {
  const mapper = statusMapperFor(provider.key);
  await prisma.order.updateMany({
    where: { id: orderId, courierBookingStatus: { in: ["UNCERTAIN", "BOOKING"] } },
    data: { courierBookingStatus: "UNCERTAIN", courierRemoteConfirmedAt: now, courierLastSyncAt: now, courierLastError: sanitizeProviderMessage(REMOTE_EXISTS(status)) },
  });
  await prisma.courierShipmentEvent.create({
    data: { orderId, provider: provider.key, source: "RECOVERY", rawStatus: status.toLowerCase().slice(0, 64), mappedEvent: mapper?.map(status) ?? "UNKNOWN", outcome: "RECORDED" },
  }).catch((e) => logServerError("courier.event-log", e, { source }));
}

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
  // "Unconfirmed" includes a BOOKING claim that never finished (stale): the call may well have reached the courier. A FRESH claim is
  // refused further down as "already in progress".
  const staleClaim = order.courierBookingStatus === "BOOKING" && now().getTime() - (order.courierBookingStartedAt?.getTime() ?? 0) >= STALE_BOOKING_MS;
  if ((order.courierBookingStatus === "UNCERTAIN" || staleClaim) && order.courierProvider && order.courierProvider !== provider.key) {
    const earlier = courierLabel(order.courierProvider);
    throw new UserFacingError(`An earlier booking with ${earlier} is still unconfirmed. Settle it with ${earlier} before booking with another courier.`);
  }
  // The courier already told us it holds a parcel for this order: nothing, not even an admin's confirmation, may create another one.
  if (order.courierRemoteConfirmedAt && order.courierBookingStatus === "UNCERTAIN") {
    throw new UserFacingError("The courier has confirmed it already holds a parcel for this order. Do not book again: wait for its status update, or enter the courier details by hand.");
  }
  const eligibility = checkBookingEligibility(toView(order), now(), opts);
  if (!eligibility.ok) throw new UserFacingError(eligibility.message);
  // Never book a parcel for an order whose required advance is unverified or whose required review is pending (advance, low-trust, fraud).
  await assertDispatchReady(prisma, orderId);
  // Never book a parcel for goods that have not been sourced yet.
  if ((await outstandingProcurementForOrder(prisma, orderId)) > 0) {
    throw new UserFacingError("Some units of this order are still waiting to be sourced, so it cannot be booked with a courier yet.");
  }

  // A retry of an unconfirmed booking: ask the courier first when it can answer. Only a positive answer is acted on.
  if ((order.courierBookingStatus === "UNCERTAIN" || order.courierBookingStatus === "BOOKING") && provider.lookupByReference && provider.features?.referenceLookup) {
    const looked = await provider.lookupByReference(order.orderNumber).catch(() => ({ kind: "unknown" as const, message: "lookup failed" }));
    if (looked.kind === "found") {
      await markRemoteConfirmed(orderId, provider, looked.status, now(), "BOOKING-CHECK");
      throw new UserFacingError(REMOTE_EXISTS(looked.status));
    }
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

  // A retry of an unconfirmed booking: whatever this attempt says, the EARLIER attempt may still have created a parcel.
  const priorUncertain = order.courierBookingStatus === "UNCERTAIN" || order.courierBookingStatus === "BOOKING";
  const secrets = [config.apiKey, config.apiSecret];

  let result: CourierBookingResult;
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
    result = { ok: false, kind: "uncertain", message: "Unexpected error while contacting the courier." };
  }

  // A consignment id that another order already holds is not ours to claim: whatever the courier meant, it is settled by hand.
  if (result.ok) {
    const holder = await findConsignmentHolder(provider.key, result.consignmentId, orderId).catch(() => null);
    if (holder) result = { ok: false, kind: "uncertain", message: `The courier returned consignment ${result.consignmentId}, which order ${holder.orderNumber} already holds.` };
  }

  if (result.ok) {
    const trackingUrl =
      (result.trackingUrl && isSafeHttpUrl(result.trackingUrl) ? result.trackingUrl : null) ??
      // Only the courier's tracking code is used: a consignment id is a different identifier and would give a wrong link.
      buildTrackingUrl(config, result.trackingCode);
    // The courier may have recorded a different cash amount than the one we sent: keep it, and say so loudly (it would collect the wrong cash).
    const echoed = typeof result.codAmount === "number" ? result.codAmount : null;
    const mismatch = echoed !== null && cents(echoed) !== cents(eligibility.codAmount);
    let savedCount = 0;
    let clash = false;
    try {
      const saved = await prisma.order.updateMany({
        // BOOKING normally. UNCERTAIN too: the scheduled job may have converted a slow claim while this call was still in flight, and the
        // consignment the courier just returned must not be lost. Never BOOKED / MANUAL (those must not be overwritten).
        where: { id: orderId, courierBookingStatus: { in: ["BOOKING", "UNCERTAIN"] }, courierConsignmentId: null },
        data: {
          courierBookingStatus: "BOOKED",
          courierProvider: provider.key,
          courierConsignmentId: result.consignmentId,
          courierName: provider.displayName,
          trackingNumber: result.trackingCode ?? result.consignmentId,
          trackingUrl,
          courierBookedAt: now(),
          courierLastStatus: result.providerStatus ? result.providerStatus.toLowerCase().slice(0, 64) : null,
          courierLastEventAt: now(),
          courierCodAmount: echoed,
          courierRemoteConfirmedAt: null,
          courierLastError: mismatch ? `The courier recorded a COD amount of ${echoed} but ${eligibility.codAmount} was sent. Check the consignment in the courier portal before dispatch.` : null,
        },
      });
      savedCount = saved.count;
    } catch (error) {
      // The database's unique index caught a consignment id another order holds (a race the lookup above could not see).
      if (!isUniqueViolation(error)) throw error;
      clash = true;
    }
    if (savedCount === 1) {
      // The booking itself is already durable. Everything below is bookkeeping: a failure here must never turn a booked order into an error.
      try {
        if (mismatch) logServerWarning("courier.cod-mismatch", "courier recorded a different COD amount", { orderNumber: order.orderNumber, provider: provider.key });
        await prisma.orderTrackingEvent.create({
          data: { orderId, status: order.status, note: `Booked with ${provider.displayName} (tracking ${result.trackingCode ?? result.consignmentId}).` },
        });
        await prisma.courierShipmentEvent.create({
          data: {
            orderId, provider: provider.key, consignmentId: result.consignmentId, source: "BOOKING",
            rawStatus: (result.providerStatus ?? "created").toLowerCase().slice(0, 64),
            mappedEvent: result.providerStatus ? provider.mapStatus(result.providerStatus) : "PENDING",
            codAmount: echoed, outcome: "APPLIED",
            note: priorUncertain ? "Booked on a retry of an earlier unconfirmed attempt." : null,
          },
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
      } catch (error) {
        logServerError("courier.book-bookkeeping", error, { orderNumber: order.orderNumber });
      }
      return { booked: true, consignmentId: result.consignmentId };
    }
    if (!clash) {
      // The order changed under us (an admin entered details by hand, say) and could not take the consignment. The courier DID create it:
      // say so, put it on the timeline, and never report a clean success.
      const lost = `The courier created consignment ${result.consignmentId}, but the order changed while it was booking, so it was not saved. Enter that consignment by hand.`;
      logServerWarning("courier.book-unsaved", "courier created a consignment the order could not take", { orderNumber: order.orderNumber, provider: provider.key });
      await logShipmentEvent({ orderId, provider: provider.key, source: "BOOKING_UNCERTAIN", rawStatus: "uncertain", consignmentId: result.consignmentId, note: lost });
      return { booked: false, message: lost };
    }
    result = { ok: false, kind: "uncertain", message: `The courier returned consignment ${result.consignmentId}, which another order already holds.` };
  }

  const message = sanitizeProviderMessage(result.message, secrets);
  // Operators need to see failed bookings in the logs (order number only — no customer data).
  logServerWarning("courier.book-failed", message, { orderNumber: order.orderNumber, provider: provider.key, outcome: result.kind });
  // A definite rejection is FAILED, EXCEPT on a retry: it says nothing about the earlier attempt, so the order stays UNCERTAIN (and one-click
  // retries, or another courier, stay blocked until a person has checked the portal).
  const keepUncertain = result.kind === "uncertain" || priorUncertain;
  await prisma.order.updateMany({
    where: { id: orderId, courierBookingStatus: "BOOKING" },
    data: { courierBookingStatus: keepUncertain ? "UNCERTAIN" : "FAILED", courierLastError: message },
  });
  await logShipmentEvent({
    orderId, provider: provider.key, source: result.kind === "rejected" ? "BOOKING_FAILED" : "BOOKING_UNCERTAIN",
    rawStatus: result.kind === "rejected" ? "rejected" : "uncertain",
    note: result.kind === "rejected" && priorUncertain ? `${message} (An earlier attempt may still exist, so the order stays unconfirmed.)` : message,
    secrets,
  });
  return {
    booked: false,
    message:
      result.kind === "rejected"
        ? priorUncertain
          ? `The courier rejected this retry: ${message}. An earlier attempt may still have created a parcel, so the order stays unconfirmed. Check the courier portal before doing anything else.`
          : `The courier rejected the booking: ${message}`
        : `Could not confirm the booking (${message}). It may have gone through — check the courier portal before retrying.`,
  };
}

// ---------------------------------------------------------------------------
// Uncertain-booking recovery
// ---------------------------------------------------------------------------

export type RecoveryResult = { outcome: "confirmed_exists" | "unknown"; message: string };

/**
 * Asks the courier whether it already holds a parcel for an UNCERTAIN (or stale BOOKING) order. It NEVER books. Only a positive answer is
 * recorded (it blocks any re-booking); anything else changes nothing and is reported as "unknown", never as "absent".
 */
export async function recoverUncertainBooking(orderId: string, opts: { actor: ServiceActor }, deps: Deps = {}): Promise<RecoveryResult> {
  await assertServiceActor(prisma, opts?.actor);
  const row = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, courierBookingStatus: true, courierBookingStartedAt: true, courierProvider: true },
  });
  if (!row) throw new UserFacingError("Order not found.");
  const { provider, now } = resolve(deps, row.courierProvider);
  const stale = row.courierBookingStatus === "BOOKING" && now().getTime() - (row.courierBookingStartedAt?.getTime() ?? 0) >= STALE_BOOKING_MS;
  if (row.courierBookingStatus !== "UNCERTAIN" && !stale) throw new UserFacingError("Only an unconfirmed booking can be checked with the courier this way.");
  if (!provider?.lookupByReference || !provider.features?.referenceLookup) {
    throw new UserFacingError("Automatic checking is not available for this courier. Check its portal, then confirm the retry or enter the details by hand.");
  }
  const run = await withLease(orderId, now(), async (): Promise<RecoveryResult> => {
    const looked = await provider.lookupByReference!(row.orderNumber).catch(() => ({ kind: "unknown" as const, message: "lookup failed" }));
    if (looked.kind === "found") {
      await markRemoteConfirmed(orderId, provider, looked.status, now());
      return { outcome: "confirmed_exists", message: REMOTE_EXISTS(looked.status) };
    }
    return { outcome: "unknown", message: "The courier could not confirm either way. Check its portal before retrying." };
  });
  if (!run.leased) throw new UserFacingError("This order is being processed right now. Try again in a moment.");
  return run.value;
}

// ---------------------------------------------------------------------------
// Status updates (webhook + poll + manual refresh share one idempotent path)
// ---------------------------------------------------------------------------

export type StatusApplyResult =
  | { applied: true; steps: OrderStatus[] }
  | { applied: false; reason: "duplicate" | "no_transition" | "not_found" | "stale" };

export type CourierEventInput = {
  rawStatus: string;
  /** The provider's own event time, only when trustworthy (see lib/courier/steadfast.ts parseProviderInstant). */
  providerEventAt?: Date | null;
  /** COD amount carried by the notification: a consignment figure, never treated as collected cash. */
  codAmount?: number | null;
  source: "WEBHOOK" | "POLL" | "RECOVERY";
};

/** Courier events that deserve a line in the order's tracking history even when they do not move the order itself. */
const HISTORY_EVENTS: readonly CourierEvent[] = ["PARTIAL_DELIVERED", "CANCELLED", "RETURNED", "DELIVERY_FAILED"];

/**
 * Records a provider status for an order and walks the order forward through the transitions the policy allows.
 *  - Idempotent: an exact replay of a timestamped notification is a no-op (unique event key); a repeat of the status already recorded is
 *    re-checked so a crash between "recorded" and "order advanced" heals itself.
 *  - Out-of-order safe: an older timestamp, or (without timestamps) a lower-progress status, is recorded as STALE and changes nothing.
 *  - Race safe: the status is claimed with a WHERE pinned to the exact state it was judged against; if someone else moved first it is re-judged.
 *  - Never touches payments: a courier-driven DELIVERED does not record COD cash (see order.service.ts).
 */
export async function applyCourierEvent(
  orderId: string,
  input: CourierEventInput,
  provider: CourierProvider,
  now: () => Date = () => new Date(),
): Promise<StatusApplyResult> {
  const status = input.rawStatus.trim().toLowerCase().slice(0, 64);
  if (!status) return { applied: false, reason: "no_transition" };
  const providerEventAt = input.providerEventAt ?? null;
  const rank = (raw: string) => provider.statusRank?.(raw) ?? null;
  const event = provider.mapStatus(status);

  let order: { status: OrderStatus; courierConsignmentId: string | null; courierLastStatus: string | null; courierEventAt: Date | null } | null = null;
  let replay = false;
  const record = async (outcome: "APPLIED" | "RECORDED" | "STALE" | "DUPLICATE", consignmentId: string | null, key: string | null) => {
    try {
      await prisma.courierShipmentEvent.create({
        data: {
          orderId, provider: provider.key, consignmentId, source: input.source, rawStatus: status, mappedEvent: event,
          providerEventAt, codAmount: input.codAmount ?? null, outcome, dedupeKey: key,
        },
      });
    } catch (error) {
      // A concurrent identical notification already logged it: that is exactly what the unique key is for.
      if (!isUniqueViolation(error)) logServerError("courier.event-log", error, { source: input.source });
    }
  };

  // Judge-and-claim, retried a few times if another request moves the state between our read and our claim.
  for (let attempt = 0; attempt < 3; attempt++) {
    order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, courierConsignmentId: true, courierLastStatus: true, courierEventAt: true } });
    if (!order) return { applied: false, reason: "not_found" };
    const key = eventDedupeKey(provider.key, order.courierConsignmentId ?? orderId, status, providerEventAt);
    if (key) {
      const seen = await prisma.courierShipmentEvent.findUnique({ where: { dedupeKey: key }, select: { id: true } });
      if (seen) {
        await prisma.order.updateMany({ where: { id: orderId }, data: { courierLastSyncAt: now() } });
        return { applied: false, reason: "duplicate" };
      }
    }
    const verdict = decideEventPrecedence({ rawStatus: order.courierLastStatus, eventAt: order.courierEventAt }, { rawStatus: status, eventAt: providerEventAt }, rank);
    if (verdict.decision === "stale") {
      await prisma.order.updateMany({ where: { id: orderId }, data: { courierLastSyncAt: now() } });
      await record("STALE", order.courierConsignmentId, key);
      return { applied: false, reason: "stale" };
    }
    if (verdict.decision === "duplicate") {
      replay = true;
      await prisma.order.updateMany({ where: { id: orderId }, data: { courierLastSyncAt: now() } });
      break;
    }
    const claim = await prisma.order.updateMany({
      where: { id: orderId, courierLastStatus: order.courierLastStatus, courierEventAt: order.courierEventAt },
      data: {
        courierLastStatus: status,
        courierLastEventAt: now(),
        courierLastSyncAt: now(),
        ...(providerEventAt ? { courierEventAt: providerEventAt } : {}),
        ...(typeof input.codAmount === "number" ? { courierCodAmount: input.codAmount } : {}),
      },
    });
    if (claim.count === 1) break;
    order = null; // someone else changed it first: judge again against the new state
  }
  if (!order) return { applied: false, reason: "no_transition" };

  // A repeat of the status we already recorded is NOT blindly ignored: the process may have crashed after recording it but before the order
  // caught up. Recompute what is still pending (each step is individually claim-guarded, so re-running is safe); only when nothing is pending
  // is it a true duplicate.
  const current = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!current) return { applied: false, reason: "not_found" };
  const plan = planOrderTransitions(current.status, event);
  const key = eventDedupeKey(provider.key, order.courierConsignmentId ?? orderId, status, providerEventAt);
  if (replay && plan.length === 0) {
    await record("DUPLICATE", order.courierConsignmentId, null);
    return { applied: false, reason: "duplicate" };
  }

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
  // Meaningful courier outcomes that did not move the order still belong in its history (neutral wording: this line can be seen by the customer).
  if (applied.length === 0 && !replay && HISTORY_EVENTS.includes(event)) {
    await prisma.orderTrackingEvent.create({ data: { orderId, status: current.status, note: `Courier update: ${COURIER_EVENT_LABEL[event]}` } }).catch((e) => logServerError("courier.history", e));
  }
  await record(applied.length > 0 ? "APPLIED" : "RECORDED", order.courierConsignmentId, key);
  return applied.length > 0 ? { applied: true, steps: applied } : { applied: false, reason: "no_transition" };
}

/** Backwards-compatible wrapper (no timestamp, no amount): a poll-style status update. */
export async function applyCourierStatus(
  orderId: string,
  rawStatus: string,
  provider: CourierProvider,
  now: () => Date = () => new Date(),
): Promise<StatusApplyResult> {
  return applyCourierEvent(orderId, { rawStatus, source: "POLL" }, provider, now);
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
  return applyCourierEvent(orderId, { rawStatus: result.status, source: "POLL" }, provider, now);
}

// ---------------------------------------------------------------------------
// Provider board: the honest state of every courier
// ---------------------------------------------------------------------------

export type CourierBoardEntry = {
  key: string;
  label: string;
  state: CourierProviderState;
  stateLabel: string;
  reason: CourierStateReason;
  /** One admin-facing sentence saying WHY the state is what it is. Never a secret. */
  detail: string;
  /** A working adapter exists. false = nothing about this courier is ever called. */
  adapterAvailable: boolean;
  isDefault: boolean;
  hasWebhookSecret: boolean;
  customBaseUrl: boolean;
  /** A real read-only connection check can be run now (adapter present, credentials set, and it has a check). */
  canTest: boolean;
  lastCheckedAt: Date | null;
  lastConnectedAt: Date | null;
  /** What the booking screens offer for this courier. */
  choice: CourierChoiceView;
};

export type CourierProviderBoard = { providers: CourierBoardEntry[]; defaultChoice: DefaultCourierChoice };

/**
 * Honest state of Steadfast, Pathao and RedX, side by side, for the admin screens. Pure derivation from (a) configuration, (b) the stored
 * result of a REAL connection check made with the same credentials, and (c) what adapters exist. "Connected" is therefore never inferred
 * from configuration. Each courier is derived on its own inside its own try/catch, and the stored checks are read with a non-throwing
 * reader: one courier (or the store) failing leaves every other row intact. Booleans, labels and messages only: no credential, no
 * credential fingerprint and no raw provider reply ever leaves this function.
 */
export async function getCourierProviderBoard(deps: { env?: Record<string, string | undefined>; now?: () => Date } = {}): Promise<CourierProviderBoard> {
  const env = deps.env ?? process.env;
  const at = (deps.now ?? (() => new Date()))();
  const checks = await getStoredConnectionChecks();
  // Guarded like every row: working out the default must not be able to take the whole board down with it.
  let defaultChoice: DefaultCourierChoice;
  try {
    defaultChoice = describeDefaultCourier(env);
  } catch (error) {
    logServerWarning("courier.board", error instanceof Error ? error.message : "error", { provider: "default" });
    defaultChoice = { key: null, reason: "none_configured", message: "The default courier could not be determined right now." };
  }
  const providers = COURIER_PROVIDERS.map((info): CourierBoardEntry => {
    const isDefault = defaultChoice.key === info.key;
    try {
      const supported = info.adapterAvailable && isSupportedCourierKey(info.key);
      const cfg = supported ? getCourierProviderConfig(info.key as SupportedCourier, env) : null;
      const usable = cfg ? isCourierUsable(cfg) : false;
      const derived = deriveProviderState({
        adapterAvailable: supported,
        blocker: info.blocker,
        usable,
        problem: cfg?.problem ?? null,
        switchedOff: supported ? isCourierSwitchedOff(info.key as SupportedCourier, env) : false,
        fingerprint: cfg && usable ? credentialFingerprint(cfg) : null,
        check: checks.get(info.key) ?? null,
        now: at,
      });
      const provider = supported && cfg && usable ? getCourierProvider(cfg) : null;
      return {
        key: info.key, label: info.label, state: derived.state, stateLabel: COURIER_STATE_LABEL[derived.state], reason: derived.reason, detail: derived.detail,
        adapterAvailable: supported, isDefault, hasWebhookSecret: Boolean(cfg?.webhookSecret), customBaseUrl: Boolean(cfg?.baseUrl),
        canTest: Boolean(provider?.checkConnection), lastCheckedAt: derived.lastCheckedAt, lastConnectedAt: derived.lastConnectedAt,
        choice: courierChoiceView({ key: info.key, label: info.label, state: derived.state, reason: derived.reason, isDefault }),
      };
    } catch (error) {
      // Could not work out this courier's state: say so, claim nothing, and keep it out of automatic booking.
      logServerWarning("courier.board", error instanceof Error ? error.message : "error", { provider: info.key });
      const reason: CourierStateReason = "error";
      return {
        key: info.key, label: info.label, state: "disconnected", stateLabel: COURIER_STATE_LABEL.disconnected, reason, detail: "The state of this courier could not be determined right now.",
        adapterAvailable: info.adapterAvailable, isDefault, hasWebhookSecret: false, customBaseUrl: false, canTest: false, lastCheckedAt: null, lastConnectedAt: null,
        choice: courierChoiceView({ key: info.key, label: info.label, state: "disconnected", reason, isDefault }),
      };
    }
  });
  return { providers, defaultChoice };
}

// ---------------------------------------------------------------------------
// Connection diagnostics (admin)
// ---------------------------------------------------------------------------

/** Configuration state of every courier, plus the switches that make automation work. Booleans and messages only: no secret value leaves here. */
export function getCourierDiagnostics(env: Record<string, string | undefined> = process.env) {
  return {
    providers: getCourierProviderStatuses(env).map((p) => ({
      key: p.key, label: p.label, adapterAvailable: p.adapterAvailable, usable: p.usable, problem: p.problem, hasWebhookSecret: p.hasWebhookSecret,
      customBaseUrl: p.customBaseUrl, blocker: p.blocker,
    })),
    cronConfigured: (env.CRON_SECRET?.trim().length ?? 0) >= 24,
    autoBook: env.COURIER_AUTO_BOOK === "true",
    invoiceLookup: usableCourierProviders(env).some((p) => getCourierProviderByKey(p.key as never, env).config.invoiceLookup),
  };
}

export type ConnectionTestResult = {
  ok: boolean;
  message: string;
  /** true = a real check reached (or tried to reach) the courier and its outcome was stored; false = nothing was contacted (no adapter / not configured). */
  checked?: boolean;
};

/**
 * Read-only credential check against ONE provider (admin button). Never creates a parcel and never returns account figures or secrets.
 * The outcome of a check that really ran is STORED (with a fingerprint of the credentials it used), which is the only thing that can ever
 * make a courier read "Connected". Nothing is stored when nothing was contacted: an unsupported or unconfigured courier proves nothing.
 */
export async function testCourierConnection(providerKey: string, actor: ServiceActor, deps: Deps = {}): Promise<ConnectionTestResult> {
  await assertServiceActor(prisma, actor);
  const { config, provider, now } = resolve(deps, providerKey);
  if (!provider || provider.key !== providerKey) return { ok: false, checked: false, message: config.problem ?? "This courier is not configured." };
  if (!provider.checkConnection) return { ok: false, checked: false, message: "This courier has no read-only connection check." };
  const secrets = [config.apiKey, config.apiSecret];
  let outcome: Awaited<ReturnType<NonNullable<CourierProvider["checkConnection"]>>>;
  try {
    outcome = await withTimeout(provider.checkConnection(), deps.checkTimeoutMs ?? config.timeoutMs * 2 + 2000);
  } catch (error) {
    outcome = error instanceof Error && error.message === "timeout"
      ? { ok: false, kind: "unreachable", message: "The courier did not answer the connection check in time." }
      : { ok: false, kind: "unexpected", message: "The connection check failed unexpectedly." };
  }
  await recordConnectionCheck({
    provider: provider.key, fingerprint: credentialFingerprint(config), secrets, now: now(),
    result: outcome.ok ? { ok: true } : { ok: false, kind: outcome.kind, message: outcome.message },
    checkedById: "adminId" in actor && actor.adminId ? actor.adminId : null,
  });
  return outcome.ok
    ? { ok: true, checked: true, message: "The courier accepted the credentials." }
    : { ok: false, checked: true, message: sanitizeProviderMessage(outcome.message, secrets) };
}

export type ConnectionTestAllEntry = {
  key: string;
  label: string;
  /** connected = a real check succeeded; failed = a real check failed; skipped = nothing to check (not configured); unsupported = no adapter. */
  outcome: "connected" | "failed" | "skipped" | "unsupported";
  message: string;
};

/**
 * Runs the read-only check for every courier at once. Providers are independent: each runs in its own guarded task, a throwing or hanging
 * one is reported as failed for ITS row only, and an unsupported courier (Pathao, RedX) is listed as unsupported without anything being called.
 */
export async function testAllCourierConnections(actor: ServiceActor, deps: Deps = {}): Promise<ConnectionTestAllEntry[]> {
  await assertServiceActor(prisma, actor);
  return Promise.all(COURIER_PROVIDERS.map(async (info): Promise<ConnectionTestAllEntry> => {
    const base = { key: info.key as string, label: info.label };
    if (!info.adapterAvailable) return { ...base, outcome: "unsupported", message: info.blocker ?? "This courier has no API adapter in this app." };
    try {
      const r = await testCourierConnection(info.key, actor, deps);
      if (r.checked === false) return { ...base, outcome: "skipped", message: r.message };
      return { ...base, outcome: r.ok ? "connected" : "failed", message: r.message };
    } catch (error) {
      logServerWarning("courier.test-all", error instanceof Error ? error.message : "error", { provider: info.key });
      return { ...base, outcome: "failed", message: "The connection check failed unexpectedly." };
    }
  }));
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
  // The documented scheme is a static bearer token checked in constant time. A forged or unauthenticated call changes nothing.
  if (!verifyBearerSecret(input.authorization, config.webhookSecret)) return { status: 401, body: { ok: false } };
  // UTF-8 BYTES, not string length (the route also bounds the read itself).
  if (utf8ByteLength(input.rawBody) > MAX_WEBHOOK_BYTES) return { status: 413, body: { ok: false } };

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { ok: false } };
  }
  let parsed: ParsedWebhook | null;
  if (provider.inspectWebhook) {
    const inspected = provider.inspectWebhook(json);
    // Authenticated but malformed: refuse it (400) so a broken sender is noticed; a notice we simply do not act on is acknowledged (200).
    if (inspected.kind === "malformed") return { status: 400, body: { ok: false, note: "malformed" } };
    parsed = inspected.kind === "event" ? inspected.event : null;
  } else {
    parsed = provider.parseWebhook(json);
  }
  if (!parsed || (!parsed.consignmentId && !parsed.reference)) return { status: 200, body: { ok: true, note: "ignored" } };

  let order = parsed.consignmentId
    ? await prisma.order.findFirst({
        where: { courierProvider: provider.key, courierConsignmentId: parsed.consignmentId },
        select: { id: true, orderNumber: true },
      })
    : null;

  // Both identifiers present but they point at different orders: do not guess which one is right.
  if (order && parsed.reference && order.orderNumber !== parsed.reference) {
    logServerWarning("courier.webhook", "consignment and invoice disagree", { provider: provider.key });
    return { status: 200, body: { ok: true, note: "mismatch" } };
  }

  // No consignment id in the notice: our own reference (order number) identifies the order, but only one this courier already holds.
  if (!order && !parsed.consignmentId && parsed.reference) {
    order = await prisma.order.findFirst({
      where: { orderNumber: parsed.reference, courierProvider: provider.key, courierBookingStatus: "BOOKED" },
      select: { id: true, orderNumber: true },
    });
  }

  // Booking answer was lost (UNCERTAIN/stale BOOKING) but the provider knows
  // our reference: adopt its consignment id so the order self-heals.
  if (!order && parsed.reference && parsed.consignmentId) {
    // Only an order whose unconfirmed booking went to THIS courier (or an older row that never recorded one) may adopt its consignment.
    const candidate = await prisma.order.findFirst({
      where: { orderNumber: parsed.reference, courierBookingStatus: { in: ["UNCERTAIN", "BOOKING"] }, OR: [{ courierProvider: provider.key }, { courierProvider: null }] },
      select: { id: true, orderNumber: true },
    });
    if (candidate) {
      // The database's unique index may refuse a consignment another order holds: that is "do not adopt", never a failure of the webhook.
      let adoptedCount = 0;
      try {
        const adopted = await prisma.order.updateMany({
          where: { id: candidate.id, courierBookingStatus: { in: ["UNCERTAIN", "BOOKING"] } },
          data: {
            courierBookingStatus: "BOOKED",
            courierProvider: provider.key,
            courierConsignmentId: parsed.consignmentId,
            courierName: provider.displayName,
            trackingNumber: parsed.consignmentId,
            trackingUrl: null, // the webhook carries no tracking code; a consignment id is not a tracking code, so no link is invented
            courierBookedAt: now(),
            courierRemoteConfirmedAt: null,
            courierLastError: null,
            ...(typeof parsed.codAmount === "number" ? { courierCodAmount: parsed.codAmount } : {}),
          },
        });
        adoptedCount = adopted.count;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        logServerWarning("courier.webhook", "consignment already held by another order", { provider: provider.key });
      }
      if (adoptedCount === 1) {
        order = candidate;
        await logShipmentEvent({
          orderId: candidate.id, provider: provider.key, source: "BOOKING", rawStatus: "adopted", consignmentId: parsed.consignmentId,
          note: "The courier's own status notification confirmed this parcel; the reply to the original booking had been lost.",
        });
      }
    }
  }

  if (!order) return { status: 200, body: { ok: true, note: "unknown consignment" } };
  const result = await applyCourierEvent(
    order.id,
    { rawStatus: parsed.status, providerEventAt: parsed.providerEventAt ?? null, codAmount: parsed.codAmount ?? null, source: "WEBHOOK" },
    provider,
    now,
  );
  return { status: 200, body: { ok: true, note: result.applied ? "applied" : result.reason } };
}

// ---------------------------------------------------------------------------
// Manual fallback
// ---------------------------------------------------------------------------

export type ManualCourierInput = {
  /** Free-text courier name. Defaults to the chosen courier's name. */
  courierName?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  /** One of the known couriers (steadfast, pathao, redx). Allowed for couriers WITHOUT an API adapter: that is what manual booking is for. */
  provider?: string | null;
  /** The courier's own consignment id for the parcel. Needs `provider`, and can belong to one order only. */
  consignmentId?: string;
};

const SAFE_CONSIGNMENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Manual courier entry: how a parcel is recorded when there is no adapter (Pathao, RedX), no credentials, or an API booking could not be
 * settled. Works with no provider configured.
 *  - Refused while an API booking exists (BOOKED) or is genuinely in flight (a fresh BOOKING claim): the stored consignment can't be
 *    silently overwritten. A STALE claim (never finished) may be settled by hand once the admin has checked the courier.
 *  - Once saved the order is MANUAL, which also blocks a later API booking (the parcel is already with a courier).
 *  - A consignment id is checked against every other order (one parcel, one order) before it is saved.
 *  - Saving with nothing filled in never erases an unconfirmed booking: it is only a "clear" for a MANUAL entry, and a MANUAL entry made
 *    on top of an unsettled booking attempt goes back to UNCONFIRMED (not "not booked") when cleared, so the doubt is never lost.
 *  - Every save and clear is recorded on the shipment timeline.
 */
export async function saveManualCourier(orderId: string, data: ManualCourierInput, actor: ServiceActor) {
  await assertServiceActor(prisma, actor);
  const providerKey = data.provider?.trim().toLowerCase() || null;
  if (providerKey && !COURIER_PROVIDERS.some((p) => p.key === providerKey)) {
    throw new UserFacingError("Choose one of the listed couriers, or leave the courier empty and type a courier name.");
  }
  const trackingNumber = data.trackingNumber?.trim().slice(0, 100) || null;
  const trackingUrl = data.trackingUrl?.trim() || null;
  const consignmentId = data.consignmentId?.trim() || null;
  const courierName = data.courierName?.trim().slice(0, 100) || (providerKey ? courierLabel(providerKey) : null);
  if (trackingUrl && (!isSafeHttpUrl(trackingUrl) || trackingUrl.length > 500)) {
    throw new UserFacingError("Tracking URL must be a valid http(s) link.");
  }
  if (consignmentId && !SAFE_CONSIGNMENT_ID.test(consignmentId)) {
    throw new UserFacingError("The consignment ID may contain only letters, numbers, dots, dashes and underscores (up to 64 characters).");
  }
  if (consignmentId && !providerKey) {
    throw new UserFacingError("Choose the courier this consignment ID belongs to.");
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, courierBookingStatus: true, courierBookingStartedAt: true, courierProvider: true },
  });
  if (!order) throw new UserFacingError("Order not found.");
  const status = order.courierBookingStatus;
  const staleClaim = status === "BOOKING" && Date.now() - (order.courierBookingStartedAt?.getTime() ?? 0) >= STALE_BOOKING_MS;
  if (status === "BOOKED" || (status === "BOOKING" && !staleClaim)) {
    throw new UserFacingError("This order is booked through the courier API (or being booked); its details can't be edited by hand.");
  }
  // Compare-and-set against exactly the state judged above: if anything moved in between, nothing is written.
  const pinned = { id: orderId, courierBookingStatus: status, ...(status === "BOOKING" ? { courierBookingStartedAt: order.courierBookingStartedAt } : {}) };
  const changed = () => new UserFacingError("This order was just changed. Refresh and check its courier details.");

  const hasAny = Boolean(courierName || trackingNumber || trackingUrl || consignmentId);

  if (!hasAny) {
    if (status === "NOT_BOOKED") return; // nothing to clear
    if (status !== "MANUAL") {
      // FAILED / UNCERTAIN / a stale claim: an empty save must never reset the state (an unconfirmed booking may be a real parcel).
      throw new UserFacingError("Enter the courier, tracking number or consignment ID. An unconfirmed or failed booking cannot be cleared by saving empty details.");
    }
    // Clearing a hand entry: if an earlier API attempt was never settled, the order is unconfirmed again rather than "not booked".
    const unsettled = (await prisma.courierShipmentEvent.count({ where: { orderId, source: { in: ["BOOKING_UNCERTAIN", "RECOVERY"] } } })) > 0;
    const cleared = await prisma.order.updateMany({
      where: pinned,
      data: {
        courierName: null, trackingNumber: null, trackingUrl: null, courierProvider: null, courierConsignmentId: null,
        courierBookingStatus: unsettled ? "UNCERTAIN" : "NOT_BOOKED",
        courierLastError: unsettled ? "Hand-entered details were cleared, but an earlier booking attempt was never settled. Check the courier portal before booking again." : null,
      },
    });
    if (cleared.count !== 1) throw changed();
    await logShipmentEvent({
      orderId, provider: order.courierProvider ?? "manual", source: "MANUAL", rawStatus: "manual_cleared",
      note: unsettled ? "Cleared. The order is unconfirmed again because an earlier booking attempt was never settled." : null,
    });
    return;
  }

  if (consignmentId && providerKey) {
    const holder = await findConsignmentHolder(providerKey, consignmentId, orderId);
    if (holder) throw new UserFacingError(`${courierLabel(providerKey)} consignment ${consignmentId} is already recorded on order ${holder.orderNumber}. One parcel can belong to one order only.`);
  }
  let count = 0;
  try {
    const res = await prisma.order.updateMany({
      where: pinned,
      data: {
        courierName, trackingNumber, trackingUrl,
        courierProvider: providerKey, courierConsignmentId: consignmentId,
        courierBookingStatus: "MANUAL", courierBookingStartedAt: null, courierRemoteConfirmedAt: null, courierLastError: null,
      },
    });
    count = res.count;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new UserFacingError("That consignment ID is already recorded on another order. One parcel can belong to one order only.");
  }
  if (count !== 1) throw changed();
  const parts = [courierName && `courier ${courierName}`, trackingNumber && `tracking ${trackingNumber}`, consignmentId && `consignment ${consignmentId}`, trackingUrl && "tracking link"].filter(Boolean);
  await logShipmentEvent({
    orderId, provider: providerKey ?? "manual", source: "MANUAL", rawStatus: "manual_entered", consignmentId,
    note: `Entered by hand: ${parts.join(", ")}.${status === "UNCERTAIN" || staleClaim ? " This replaced an unconfirmed booking attempt." : ""}`,
  });
}

// ---------------------------------------------------------------------------
// Attention list: orders whose local state may disagree with the courier's, or that need a person
// ---------------------------------------------------------------------------
export const SILENT_SHIPMENT_MS = 3 * 24 * 3600 * 1000;

export type CourierAttentionReason =
  | "uncertain" | "remote_confirmed" | "stale_booking" | "silent_shipment" | "failed"
  | "partial_delivery" | "courier_cancelled" | "cod_amount_mismatch";

const ACTIVE_STATUSES = ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] as OrderStatus[];

/**
 * Orders an admin should look at: a booking whose outcome is unknown (UNCERTAIN) or that the courier confirmed exists, a booking claim that
 * never finished (stale BOOKING), a booking that failed, a PARTIAL delivery, a consignment the courier cancelled while the order is still
 * live, a COD amount at the courier that differs from ours, or a shipment that has heard nothing from the courier for days. Read-only.
 */
export async function listCourierAttention(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_BOOKING_MS);
  const silentBefore = new Date(now.getTime() - SILENT_SHIPMENT_MS);
  const select = {
    id: true, orderNumber: true, status: true, courierBookingStatus: true, courierConsignmentId: true,
    courierLastStatus: true, courierLastEventAt: true, courierBookedAt: true, courierLastError: true,
    courierRemoteConfirmedAt: true, courierProvider: true, courierCodAmount: true, paymentMethod: true, paymentStatus: true, total: true, advancePaid: true,
  } as const;
  const rows = await prisma.order.findMany({
    where: {
      OR: [
        { courierBookingStatus: "UNCERTAIN" },
        { courierBookingStatus: "FAILED", status: { in: ["CONFIRMED", "PROCESSING"] } },
        { courierBookingStatus: "BOOKING", courierBookingStartedAt: { lt: staleBefore } },
        {
          courierBookingStatus: "BOOKED",
          status: { in: ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] },
          OR: [{ courierLastEventAt: { lt: silentBefore } }, { courierLastEventAt: null, courierBookedAt: { lt: silentBefore } }],
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: 200,
    select,
  });
  const out = new Map<string, (typeof rows)[number] & { reason: CourierAttentionReason }>();
  for (const o of rows) {
    out.set(o.id, {
      ...o,
      reason: o.courierBookingStatus === "UNCERTAIN" ? (o.courierRemoteConfirmedAt ? "remote_confirmed" : "uncertain")
        : o.courierBookingStatus === "BOOKING" ? "stale_booking"
        : o.courierBookingStatus === "FAILED" ? "failed" : "silent_shipment",
    });
  }
  // Booked, still-live orders whose last courier status needs a human (read through the provider's credential-free vocabulary).
  const live = await prisma.order.findMany({
    where: { courierBookingStatus: "BOOKED", status: { in: ACTIVE_STATUSES } },
    orderBy: { updatedAt: "asc" },
    take: 300,
    select,
  });
  for (const o of live) {
    const mapper = statusMapperFor(o.courierProvider);
    const ev = mapper && o.courierLastStatus ? mapper.map(o.courierLastStatus) : null;
    const reason: CourierAttentionReason | null =
      ev === "PARTIAL_DELIVERED" ? "partial_delivery"
      : ev === "CANCELLED" || ev === "RETURNED" || ev === "DELIVERY_FAILED" ? "courier_cancelled"
      : o.courierCodAmount != null && cents(Number(o.courierCodAmount)) !== cents(expectedCourierCod(o)) ? "cod_amount_mismatch"
      : null;
    if (reason) out.set(o.id, { ...o, reason });
  }
  return [...out.values()].slice(0, 200);
}

// ---------------------------------------------------------------------------
// Shipments list (admin filters)
// ---------------------------------------------------------------------------

export const SHIPMENT_FILTERS = ["not_booked", "booking", "booked", "failed", "uncertain", "delivered", "delivery_failed"] as const;
export type ShipmentFilter = (typeof SHIPMENT_FILTERS)[number];
export const SHIPMENT_FILTER_LABEL: Record<ShipmentFilter, string> = {
  not_booked: "Not booked", booking: "Booking", booked: "Booked", failed: "Failed", uncertain: "Uncertain", delivered: "Delivered", delivery_failed: "Delivery failed",
};
export const isShipmentFilter = (v: unknown): v is ShipmentFilter => typeof v === "string" && (SHIPMENT_FILTERS as readonly string[]).includes(v);

function shipmentWhere(filter: ShipmentFilter): Prisma.OrderWhereInput {
  switch (filter) {
    // Orders actually waiting to be dispatched (not every pending/cancelled order that happens to be unbooked).
    case "not_booked": return { courierBookingStatus: "NOT_BOOKED", status: { in: ["CONFIRMED", "PROCESSING"] }, fulfillmentMode: { not: "MARKETPLACE_FULFILLED" } };
    case "booking": return { courierBookingStatus: "BOOKING" };
    case "booked": return { courierBookingStatus: "BOOKED", status: { in: ACTIVE_STATUSES } };
    case "failed": return { courierBookingStatus: "FAILED" };
    case "uncertain": return { courierBookingStatus: "UNCERTAIN" };
    case "delivered": return { status: "DELIVERED", courierBookingStatus: { in: ["BOOKED", "MANUAL"] } };
    case "delivery_failed": return { status: "FAILED_DELIVERY", courierBookingStatus: { in: ["BOOKED", "MANUAL"] } };
  }
}

const SHIPMENT_PAGE = 25;

export async function listCourierShipments(filter: ShipmentFilter, page = 1) {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const where = shipmentWhere(filter);
  const [rows, total, counts] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (safePage - 1) * SHIPMENT_PAGE,
      take: SHIPMENT_PAGE,
      select: {
        id: true, orderNumber: true, status: true, courierBookingStatus: true, courierProvider: true, courierName: true, courierConsignmentId: true,
        trackingNumber: true, trackingUrl: true, courierLastStatus: true, courierLastSyncAt: true, courierLastError: true, updatedAt: true,
      },
    }),
    prisma.order.count({ where }),
    Promise.all(SHIPMENT_FILTERS.map(async (f) => [f, await prisma.order.count({ where: shipmentWhere(f) })] as const)),
  ]);
  return { rows, total, page: safePage, pageCount: Math.max(1, Math.ceil(total / SHIPMENT_PAGE)), counts: Object.fromEntries(counts) as Record<ShipmentFilter, number> };
}

// ---------------------------------------------------------------------------
// Scheduled reconciliation (called by /api/courier/reconcile from an external scheduler)
// ---------------------------------------------------------------------------

export type ReconcileSummary = {
  polled: number; updated: number; pollFailed: number; autoBooked: number; autoBookSkipped: number;
  /** BOOKING claims older than the stale limit converted to UNCERTAIN so they become visible and recoverable. */
  staleRecovered: number;
  /** UNCERTAIN bookings the courier was asked about / of which the courier confirmed a parcel exists. */
  uncertainChecked: number; remoteConfirmed: number;
  /** Orders another run (or an admin recovery) was already processing, or backing off after a failure. */
  busySkipped: number;
  /** Delivered COD orders whose cash collection staff have not confirmed yet (read-only count). */
  codAwaitingConfirmation: number;
};

/**
 * Bounded, sequential, idempotent maintenance pass. Every phase reads its work from the database (nothing lives in memory between runs), each
 * order is leased while it is processed, and one order's failure never affects another. Re-running after a crash simply continues.
 *  1. stale detection: a BOOKING claim that never finished becomes UNCERTAIN (visible, recoverable; never re-booked automatically);
 *  2. uncertain recovery: when the courier supports a reference lookup, ask it about UNCERTAIN orders (only a positive answer is recorded);
 *  3. status polling of in-flight API-booked consignments (webhooks can be missed), through the same path as the webhook;
 *  4. ONLY when COURIER_AUTO_BOOK=true (off by default), book CONFIRMED never-booked orders through bookOrderWithCourier(), whose gates and
 *     conditional claim make an ineligible or duplicate booking impossible;
 *  5. COD: report (not change) delivered COD orders still awaiting cash confirmation.
 */
export async function reconcileCourier(opts: { pollLimit?: number; bookLimit?: number; autoBook?: boolean; recoverLimit?: number } = {}, deps: Deps = {}): Promise<ReconcileSummary> {
  const { provider, now } = resolve(deps);
  const out: ReconcileSummary = { polled: 0, updated: 0, pollFailed: 0, autoBooked: 0, autoBookSkipped: 0, staleRecovered: 0, uncertainChecked: 0, remoteConfirmed: 0, busySkipped: 0, codAwaitingConfirmation: 0 };
  // Orders are polled through the courier each was BOOKED with (not just the default one). Injected deps (tests) keep the single-provider behaviour.
  const keys = deps.provider !== undefined || deps.config !== undefined ? (provider ? [provider.key] : []) : usableCourierProviders(deps.env ?? process.env).map((p) => p.key as string);
  if (keys.length === 0) return out; // no courier usable: manual operation only
  const clock = now();

  // 1. Stale BOOKING claims -> UNCERTAIN. Conditional update: running it twice, or concurrently, converts each order once.
  const staleBefore = new Date(clock.getTime() - STALE_BOOKING_MS);
  const staleRows = await prisma.order.findMany({
    where: { courierBookingStatus: "BOOKING", courierBookingStartedAt: { lt: staleBefore } },
    select: { id: true, courierProvider: true },
    take: 500,
  });
  const STALE_NOTE = "A booking started but never finished (the server may have restarted). Whether the courier created a parcel is unknown.";
  for (const row of staleRows) {
    // Per order and conditional (the WHERE re-checks the claim is still stale): a booking that finished meanwhile is left alone.
    const converted = await prisma.order.updateMany({
      where: { id: row.id, courierBookingStatus: "BOOKING", courierBookingStartedAt: { lt: staleBefore } },
      data: { courierBookingStatus: "UNCERTAIN", courierLastError: STALE_NOTE },
    });
    if (converted.count !== 1) continue;
    out.staleRecovered++;
    await logShipmentEvent({ orderId: row.id, provider: row.courierProvider ?? "unknown", source: "BOOKING_UNCERTAIN", rawStatus: "uncertain", note: STALE_NOTE });
  }

  // 2. Uncertain bookings: ask the courier (only providers that can answer; nothing is ever booked here).
  const uncertain = await prisma.order.findMany({
    where: { courierBookingStatus: "UNCERTAIN", courierRemoteConfirmedAt: null, courierProvider: { in: keys } },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(opts.recoverLimit ?? 20, 1), 50),
    select: { id: true, courierProvider: true },
  });
  for (const { id } of uncertain) {
    const p = resolve(deps, uncertain.find((u) => u.id === id)?.courierProvider).provider;
    if (!p?.lookupByReference || !p.features?.referenceLookup) continue; // this courier cannot answer: stays UNCERTAIN for an admin
    try {
      const r = await recoverUncertainBooking(id, { actor: { system: "courier-reconcile" } }, deps);
      out.uncertainChecked++;
      if (r.outcome === "confirmed_exists") out.remoteConfirmed++;
    } catch (error) {
      if (error instanceof UserFacingError) out.busySkipped++;
      else logServerWarning("courier.reconcile.recover", error instanceof Error ? error.message : "error", { orderId: id });
    }
  }

  // 3. Poll in-flight consignments. Booking does not move the order, so a booked order may still be CONFIRMED.
  const due = await prisma.order.findMany({
    where: {
      courierBookingStatus: "BOOKED", courierProvider: { in: keys }, courierConsignmentId: { not: null },
      status: { in: ACTIVE_STATUSES },
      OR: [{ courierLastSyncAt: null }, { courierLastSyncAt: { lt: new Date(clock.getTime() - MIN_POLL_INTERVAL_MS) } }],
    },
    orderBy: [{ courierLastSyncAt: { sort: "asc", nulls: "first" } }, { courierBookedAt: "asc" }],
    take: Math.min(Math.max(opts.pollLimit ?? 25, 1), 100) + 50, // headroom: finished consignments are skipped below
    select: { id: true, courierProvider: true, courierLastStatus: true },
  });
  let polled = 0;
  const pollCap = Math.min(Math.max(opts.pollLimit ?? 25, 1), 100);
  for (const { id, courierProvider, courierLastStatus } of due) {
    if (polled >= pollCap) break;
    // A consignment the courier has settled for good needs no more polling (an admin handles whatever it left behind).
    const mapper = statusMapperFor(courierProvider);
    if (courierLastStatus && mapper?.isFinal(courierLastStatus)) continue;
    polled++;
    out.polled++;
    const run = await withLease(id, clock, async () => {
      try {
        const r = await refreshCourierStatus(id, { system: "courier-reconcile" }, deps);
        if (r.applied) out.updated++;
      } catch (error) {
        out.pollFailed++;
        // Back off: leave the lease in place so a broken consignment does not occupy every run's batch.
        await prisma.order.updateMany({ where: { id }, data: { courierSyncLeaseUntil: new Date(clock.getTime() + FAILURE_BACKOFF_MS) } }).catch(() => undefined);
        logServerWarning("courier.reconcile.poll", error instanceof Error ? error.message : "error", { orderId: id });
      }
    });
    if (!run.leased) { out.polled--; polled--; out.busySkipped++; }
  }

  // 4. Automatic booking (off unless explicitly enabled after a verified live test).
  if (opts.autoBook) {
    const candidates = await prisma.order.findMany({
      where: { status: "CONFIRMED", courierBookingStatus: "NOT_BOOKED", fulfillmentMode: { not: "MARKETPLACE_FULFILLED" } },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(opts.bookLimit ?? 10, 1), 50),
      select: { id: true },
    });
    for (const { id } of candidates) {
      const run = await withLease(id, clock, async () => {
        try {
          await bookOrderWithCourier(id, { actor: { system: "courier-reconcile" } }, deps);
          out.autoBooked++;
        } catch (error) {
          out.autoBookSkipped++; // ineligible / rejected / uncertain: visible on the Courier page, never auto-retried here
          logServerWarning("courier.reconcile.book", error instanceof Error ? error.message : "error", { orderId: id });
        }
      });
      if (!run.leased) out.busySkipped++;
    }
  }

  // 5. COD cash awaiting staff confirmation (report only: money is never changed by a job).
  out.codAwaitingConfirmation = await prisma.order.count({ where: { status: "DELIVERED", paymentMethod: "COD", courierBookingStatus: "BOOKED", paymentStatus: { not: "PAID" } } });

  logServerInfo("courier.reconcile", "pass finished", { ...out });
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
