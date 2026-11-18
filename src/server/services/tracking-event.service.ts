import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { purchaseEventId } from "@/lib/analytics/ids";
import {
  PURCHASE_ELIGIBLE_STATUSES,
  SENDING_STALE_MS,
  isEventTooOld,
  maxEventAgeMs,
  mayDeliverServerEvent,
  nextRetryDelayMs,
  purchaseEligibility,
  type ConsentMode,
  type ConsentSnapshot,
  type SkipReason,
  type TrackingDestination,
} from "@/lib/analytics/purchase-policy";
import { buildPurchaseEvent, redactSensitive, resolveMetaConfig, sendMetaEvents } from "@/lib/analytics/server-events";
import { buildGa4PurchasePayload, resolveGa4Config, sendGa4Purchase } from "@/lib/analytics/ga4-mp";
import type { PurchaseInput } from "@/lib/analytics/payloads";

/**
 * Server-side ad-platform event lifecycle: Meta Conversions API (META_CAPI) and GA4 Measurement Protocol (GA4_MP), one shared lifecycle.
 *
 *   order enters CONFIRMED -> trackOrderConfirmed -> PERSIST one TrackingEventLog row per configured destination (PENDING)   [fast, reliable]
 *                                                  -> best-effort kick via after() (runs after the admin's response)
 *   delivery (after() kick, the retry job, or an admin retry, whichever comes first):
 *                    claim -> re-read the ORDER -> eligibility / consent / age / config -> consent re-check -> send -> SENT / retry / FAILED / SKIPPED
 *
 * Background-first: confirming an order NEVER waits for Meta or Google. The persisted PENDING row is the source of truth; `after()` is only
 * an optimisation. The guaranteed mechanism is the retry job (POST /api/tracking/retry, or "Run delivery job now"), which also recovers
 * a crashed worker (stale SENDING claims) and back-fills orders whose enqueue never happened.
 *
 * Guarantees (covered by tests/services/tracking-event.test.ts and tracking-p31.test.ts):
 *  - One row per (destination, event, order): a Purchase can never be queued twice (unique key + createMany skipDuplicates).
 *  - A row is claimed by exactly one worker at a time; a crashed claim is re-claimable after SENDING_STALE_MS.
 *  - What is sent is rebuilt from the order in the DATABASE at delivery time, never from anything the browser submitted.
 *  - Consent is checked at delivery AND again immediately before the request; a withdrawal turns pending rows into SKIPPED consent_withdrawn.
 *  - An order cancelled/refunded before delivery is SKIPPED. An already-accepted event is never "un-sent" (neither platform has such an API).
 *  - Nothing here throws to its caller; rows, logs and errors hold no email/phone/name/token/secret.
 */

const META: TrackingDestination = "META_CAPI";
const GA4: TrackingDestination = "GA4_MP";
const EVENT = "Purchase";

export type DeliveryOutcome = "sent" | "retry_scheduled" | "failed" | "skipped" | "not_claimed" | "not_found";

type Db = typeof prisma;

async function getTrackingSettings(db: Db) {
  const s = await db.storeSettings.findFirst({ select: { metaPixelId: true, gtmId: true, consentMode: true } });
  return { metaPixelId: s?.metaPixelId ?? null, gtmId: s?.gtmId ?? null, consentMode: (s?.consentMode ?? "OFF") as ConsentMode };
}

type Settings = Awaited<ReturnType<typeof getTrackingSettings>>;

/** Destinations that can currently deliver (configuration present). */
export function configuredDestinations(settings: Pick<Settings, "metaPixelId" | "gtmId">, env: Record<string, string | undefined> = process.env): TrackingDestination[] {
  const out: TrackingDestination[] = [];
  if (resolveMetaConfig(settings.metaPixelId, env).ok) out.push(META);
  if (resolveGa4Config(settings.gtmId, env).ok) out.push(GA4);
  return out;
}

/**
 * True when GA4 purchase is delivered by the server. The storefront then OMITS the browser GA4 purchase (one sender, no double counting).
 * In debug/validation mode (GA4_MP_DEBUG) nothing is recorded by GA4, so the browser keeps sending.
 */
export async function isGa4ServerPurchaseActive(db: Db = prisma, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    const s = await getTrackingSettings(db);
    const cfg = resolveGa4Config(s.gtmId, env);
    return cfg.ok && !cfg.config.debug;
  } catch {
    return false;
  }
}

/** Public origin for event_source_url. Falls back to the env URL if the SEO helper is unavailable. */
async function siteOrigin(): Promise<string> {
  try {
    const { getCanonicalOrigin } = await import("@/server/services/seo.service");
    return await getCanonicalOrigin();
  } catch {
    return (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  }
}

// ------------------------------------------------------------------------------------------------------------------ enqueue

/**
 * Persists the Purchase for every configured destination. Idempotent. Creates nothing when no destination is configured (no audit value
 * for a store that does not use them); the maintenance job picks such orders up if one is configured later and the confirmation is still
 * inside that destination's window. `logId` is the Meta row when there is one (else the first created), `logIds` are all of them.
 */
export async function enqueuePurchaseEvent(
  orderId: string,
  opts: { eventTime?: Date; db?: Db } = {},
): Promise<{ logId: string | null; logIds: string[]; reason?: SkipReason | "already_queued" }> {
  const db = opts.db ?? prisma;
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, channelId: true } });
  if (!order) return { logId: null, logIds: [], reason: "order_not_eligible" };
  const eligibility = purchaseEligibility(order);
  if (!eligibility.eligible) return { logId: null, logIds: [], reason: eligibility.reason };

  const destinations = configuredDestinations(await getTrackingSettings(db));
  if (destinations.length === 0) return { logId: null, logIds: [], reason: "not_configured" };

  const eventTime = opts.eventTime ?? new Date();
  const created = await db.trackingEventLog.createMany({
    data: destinations.map((destination) => ({
      destination, eventName: EVENT, eventId: purchaseEventId(order.orderNumber), orderId: order.id, orderNumber: order.orderNumber,
      status: "PENDING" as const, eventTime, nextAttemptAt: eventTime,
    })),
    skipDuplicates: true,
  });
  const rows = await db.trackingEventLog.findMany({ where: { orderId: order.id, eventName: EVENT, destination: { in: destinations } }, select: { id: true, destination: true } });
  const logIds = rows.map((r) => r.id);
  const logId = rows.find((r) => r.destination === META)?.id ?? rows[0]?.id ?? null;
  return { logId, logIds, ...(created.count === 0 ? { reason: "already_queued" as const } : {}) };
}

// ------------------------------------------------------------------------------------------------------------------ deliver

/**
 * Removes the visitor's network/browser identifiers once NO event of the order can still be delivered: every destination has been sent or
 * skipped. A FAILED event counts as still open, because an admin can retry it and it then needs the same identifiers; those are removed by
 * the 8-day cleanup in runTrackingMaintenance (or immediately by a consent withdrawal). Deliveries run in parallel, so without this a
 * destination that failed first would have its identifiers erased by the other one succeeding.
 */
async function scrubIfSettled(db: Db, orderId: string, now: Date) {
  const open = await db.trackingEventLog.count({ where: { orderId, status: { in: ["PENDING", "SENDING", "FAILED"] } } });
  if (open > 0) return;
  await db.orderAttribution.updateMany({
    where: { orderId, contactScrubbedAt: null },
    data: { clientIp: null, clientUserAgent: null, gaClientId: null, gaSessionId: null, contactScrubbedAt: now },
  });
}

type Attribution = { consentState: string; consentWithdrawnAt: Date | null } | null;

function consentVerdict(mode: ConsentMode, attribution: Attribution): SkipReason | null {
  if (attribution?.consentWithdrawnAt) return "consent_withdrawn";
  const snapshot = (attribution?.consentState ?? "UNKNOWN") as ConsentSnapshot;
  return mayDeliverServerEvent(mode, snapshot) ? null : "consent_not_granted";
}

type SendOutcome =
  | { ok: true; httpStatus: number; fbtraceId?: string; validationOnly?: boolean }
  | { ok: false; retryable: boolean; httpStatus?: number; code?: string; message: string; fbtraceId?: string };

/**
 * Attempts one delivery. `manual` = an admin pressed "retry": it gets exactly one more attempt (a retryable failure ends as FAILED
 * rather than being rescheduled). Never throws.
 */
export async function deliverTrackingEvent(
  logId: string,
  opts: { now?: Date; fetchImpl?: typeof fetch; manual?: boolean; timeoutMs?: number; db?: Db } = {},
): Promise<DeliveryOutcome> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  try {
    // 1. Claim. Exactly one caller wins; a stale SENDING claim (crashed worker) can be taken over.
    const claimed = await db.trackingEventLog.updateMany({
      where: {
        id: logId,
        OR: [
          { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } },
        ],
      },
      data: { status: "SENDING", attempts: { increment: 1 }, lastAttemptAt: now, updatedAt: now },
    });
    if (claimed.count !== 1) return "not_claimed";

    const log = await db.trackingEventLog.findUnique({ where: { id: logId } });
    if (!log) return "not_found";

    const finish = async (data: Record<string, unknown>) => {
      await db.trackingEventLog.updateMany({ where: { id: logId, status: "SENDING" }, data: { ...data, updatedAt: now } });
    };
    const skip = async (reason: SkipReason, scrub: boolean) => {
      await finish({ status: "SKIPPED", skipReason: reason, nextAttemptAt: null, errorCode: null, errorMessage: null });
      if (scrub) await scrubIfSettled(db, log.orderId, now);
      return "skipped" as const;
    };

    // 2. The ORDER is the source of truth: re-read it now.
    const order = await db.order.findUnique({
      where: { id: log.orderId },
      select: {
        id: true, orderNumber: true, status: true, channelId: true, total: true, currency: true, email: true, phone: true, userId: true,
        shippingSnapshot: true, shippingTotal: true, taxTotal: true, coupon: { select: { code: true } },
        items: { select: { productId: true, productName: true, variantName: true, unitPrice: true, quantity: true } },
      },
    });
    if (!order) return await skip("order_not_eligible", true);
    const eligibility = purchaseEligibility(order);
    if (!eligibility.eligible) return await skip(eligibility.reason, true);

    // 3. Consent: what the visitor decided (and may since have withdrawn), judged against the CURRENT store mode.
    const settings = await getTrackingSettings(db);
    const attribution = await db.orderAttribution.findUnique({ where: { orderId: order.id } });
    const blocked = consentVerdict(settings.consentMode, attribution);
    if (blocked) return await skip(blocked, true);

    // 4. The destination's own event-age window.
    if (isEventTooOld(log.eventTime, now.getTime(), maxEventAgeMs(log.destination))) return await skip("event_too_old", true);

    // 5. Build from server data (destination specific). Configuration problems are recoverable (the job re-queues them once fixed).
    const purchase: PurchaseInput = {
      orderNumber: order.orderNumber,
      total: Number(order.total),
      shipping: Number(order.shippingTotal),
      tax: Number(order.taxTotal),
      coupon: order.coupon?.code ?? null,
      currency: order.currency,
      items: order.items.map((i) => ({ id: i.productId, name: i.productName, price: Number(i.unitPrice), quantity: i.quantity, variant: i.variantName })),
    };
    let send: () => Promise<SendOutcome>;
    let apiVersion: string | null = null;

    if (log.destination === GA4) {
      const cfg = resolveGa4Config(settings.gtmId);
      if (!cfg.ok) return await skip("not_configured", false);
      if (!attribution?.gaClientId) return await skip("no_client_id", true); // never invent a client id
      const payload = buildGa4PurchasePayload({ order: purchase, eventId: log.eventId, clientId: attribution.gaClientId, sessionId: attribution.gaSessionId, eventTime: log.eventTime });
      send = async () => {
        const r = await sendGa4Purchase(cfg.config, payload, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
        return r.ok ? { ok: true, httpStatus: r.httpStatus, validationOnly: r.debugOnly } : r;
      };
    } else {
      const cfg = resolveMetaConfig(settings.metaPixelId);
      if (!cfg.ok) return await skip("not_configured", false);
      apiVersion = cfg.config.apiVersion;
      const shipping = (order.shippingSnapshot ?? {}) as { fullName?: string; city?: string; country?: string };
      const event = buildPurchaseEvent({
        order: {
          orderNumber: order.orderNumber, total: Number(order.total), currency: order.currency, email: order.email, phone: order.phone, userId: order.userId,
          shipping: { fullName: shipping.fullName, city: shipping.city, country: shipping.country },
          items: order.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: Number(i.unitPrice) })),
        },
        eventId: log.eventId,
        eventTime: log.eventTime,
        sourceUrl: `${await siteOrigin()}/checkout`,
        attribution: { fbc: attribution?.fbc, fbp: attribution?.fbp, ip: attribution?.clientIp, userAgent: attribution?.clientUserAgent },
        now: now.getTime(),
      });
      send = () => sendMetaEvents(cfg.config, [event], { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
    }

    // 6. Last consent check, immediately before the request: a withdrawal that arrived while this event was being prepared still wins.
    const latest = await db.orderAttribution.findUnique({ where: { orderId: order.id } });
    const lateBlock = consentVerdict(settings.consentMode, latest);
    if (lateBlock) return await skip(lateBlock, true);

    const result = await send();

    if (result.ok) {
      if (result.validationOnly) return await skip("validation_only", true); // GA4_MP_DEBUG: validated by Google, NOT recorded
      await finish({ status: "SENT", sentAt: now, httpStatus: result.httpStatus, fbtraceId: result.fbtraceId ?? null, apiVersion, nextAttemptAt: null, errorCode: null, errorMessage: null, skipReason: null });
      await scrubIfSettled(db, order.id, now);
      return "sent";
    }

    const errorFields = { httpStatus: result.httpStatus ?? null, errorCode: result.code ?? null, errorMessage: result.message, fbtraceId: result.fbtraceId ?? null, apiVersion };
    const delay = result.retryable && !opts.manual ? nextRetryDelayMs(log.attempts) : null;
    if (delay === null) {
      await finish({ status: "FAILED", nextAttemptAt: null, ...errorFields });
      return "failed";
    }
    await finish({ status: "PENDING", nextAttemptAt: new Date(now.getTime() + delay), ...errorFields });
    return "retry_scheduled";
  } catch (error) {
    // Unexpected (DB hiccup, bug): release the claim for a later retry. No customer data in the log.
    console.error("[tracking] delivery crashed", { logId, name: error instanceof Error ? error.name : "unknown" });
    try {
      await db.trackingEventLog.updateMany({
        where: { id: logId, status: "SENDING" },
        data: { status: "PENDING", nextAttemptAt: new Date((opts.now ?? new Date()).getTime() + 5 * 60_000), errorCode: "internal", errorMessage: redactSensitive(error instanceof Error ? error.message : "unexpected error") },
      });
    } catch {
      // The stale-claim rule will recover it.
    }
    return "retry_scheduled";
  }
}

// ------------------------------------------------------------------------------------------------------------------ hook

/** Delivers this order's due events (all destinations). Used by the after() kick; the retry job does the same for every order. */
export async function deliverDueEventsForOrder(orderId: string, opts: { now?: Date; fetchImpl?: typeof fetch; db?: Db } = {}): Promise<DeliveryOutcome[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const rows = await db.trackingEventLog.findMany({
    where: { orderId, eventName: EVENT, status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    select: { id: true },
  });
  return Promise.all(rows.map((r) => deliverTrackingEvent(r.id, { now, fetchImpl: opts.fetchImpl, db })));
}

/**
 * Called by adminUpdateOrderStatus AFTER the status change has committed. It only PERSISTS the events (a few fast database writes) and
 * schedules a best-effort delivery with after(); it never waits for Meta or Google. If scheduling is unavailable or the process dies, the
 * PENDING rows are delivered by the retry job; if even the persist fails, the job back-fills from the order's CONFIRMED history row.
 * Never throws.
 */
export async function trackOrderConfirmed(orderId: string): Promise<void> {
  try {
    await enqueuePurchaseEvent(orderId);
  } catch {
    console.error("[tracking] could not persist the confirmed-order event; the retry job will back-fill it");
    return;
  }
  try {
    after(async () => {
      try {
        await deliverDueEventsForOrder(orderId);
      } catch {
        // the retry job delivers it
      }
    });
  } catch {
    // Called outside a request scope (or after() unavailable): the retry job delivers it.
  }
}

// ------------------------------------------------------------------------------------------------------------------ maintenance

export type MaintenanceSummary = { queued: number; requeued: number; delivered: Record<DeliveryOutcome, number>; scrubbed: number };

/**
 * Run by the scheduled job (and the admin "Run now" button). This is the GUARANTEED delivery mechanism:
 *  1. enqueue confirmed website orders (last ~7 days) that are missing an event row for a configured destination (a crash between commit and
 *     persist, or a destination configured later);
 *  2. re-queue rows skipped only because the destination was not configured, if it is now (and still inside its window);
 *  3. deliver due rows, including crashed (stale SENDING) claims;
 *  4. remove identifiers from attributions whose window has closed.
 */
export async function runTrackingMaintenance(opts: { now?: Date; fetchImpl?: typeof fetch; batch?: number; db?: Db } = {}): Promise<MaintenanceSummary> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 25;
  const summary: MaintenanceSummary = { queued: 0, requeued: 0, delivered: { sent: 0, retry_scheduled: 0, failed: 0, skipped: 0, not_claimed: 0, not_found: 0 }, scrubbed: 0 };
  const settings = await getTrackingSettings(db);
  const destinations = configuredDestinations(settings);

  if (destinations.length > 0) {
    const widest = Math.max(...TRACKING_WINDOW_MS(destinations));
    const cutoff = new Date(now.getTime() - widest);
    const candidates = await db.order.findMany({
      where: { channelId: WEBSITE_CHANNEL_ID, status: { in: [...PURCHASE_ELIGIBLE_STATUSES] }, trackingEvents: { some: { status: "CONFIRMED", createdAt: { gte: cutoff } } } },
      select: { id: true, trackingEvents: { where: { status: "CONFIRMED" }, select: { createdAt: true } }, trackingEventLogs: { select: { eventName: true, destination: true } } },
      take: batch * 4,
    });
    for (const o of candidates) {
      if (summary.queued >= batch) break;
      const have = new Set(o.trackingEventLogs.filter((l) => l.eventName === EVENT).map((l) => l.destination));
      if (destinations.every((d) => have.has(d))) continue;
      const confirmedAt = o.trackingEvents.map((e) => e.createdAt).sort((a, b) => a.getTime() - b.getTime())[0];
      const r = await enqueuePurchaseEvent(o.id, { eventTime: confirmedAt, db });
      if (r.logId && r.reason !== "already_queued") summary.queued += 1;
    }
    for (const destination of destinations) {
      const reopened = await db.trackingEventLog.updateMany({
        where: { destination, eventName: EVENT, status: "SKIPPED", skipReason: "not_configured", eventTime: { gte: new Date(now.getTime() - maxEventAgeMs(destination)) } },
        data: { status: "PENDING", nextAttemptAt: now, skipReason: null },
      });
      summary.requeued += reopened.count;
    }
  }

  const due = await db.trackingEventLog.findMany({
    where: {
      OR: [
        { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: batch,
  });
  for (const row of due) summary.delivered[await deliverTrackingEvent(row.id, { now, fetchImpl: opts.fetchImpl, db })] += 1;

  const scrubbed = await db.orderAttribution.updateMany({
    where: { contactScrubbedAt: null, createdAt: { lt: new Date(now.getTime() - 8 * 86_400_000) } },
    data: { clientIp: null, clientUserAgent: null, gaClientId: null, gaSessionId: null, contactScrubbedAt: now },
  });
  summary.scrubbed = scrubbed.count;
  return summary;
}

const TRACKING_WINDOW_MS = (destinations: TrackingDestination[]) => destinations.map((d) => maxEventAgeMs(d));

/** Admin "retry": re-opens a FAILED row (or one skipped for a recoverable reason) for exactly one more attempt. */
export async function retryTrackingEvent(logId: string, opts: { now?: Date; fetchImpl?: typeof fetch; db?: Db } = {}): Promise<DeliveryOutcome> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const reopened = await db.trackingEventLog.updateMany({
    where: { id: logId, OR: [{ status: "FAILED" }, { status: "SKIPPED", skipReason: "not_configured" }] },
    data: { status: "PENDING", nextAttemptAt: now, skipReason: null },
  });
  if (reopened.count !== 1) return "not_claimed";
  return deliverTrackingEvent(logId, { now, fetchImpl: opts.fetchImpl, manual: true, db });
}
