import "server-only";
import { prisma } from "@/lib/db/prisma";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { purchaseEventId } from "@/lib/analytics/ids";
import {
  PURCHASE_ELIGIBLE_STATUSES,
  META_MAX_EVENT_AGE_MS,
  SENDING_STALE_MS,
  isEventTooOld,
  mayDeliverServerEvent,
  nextRetryDelayMs,
  purchaseEligibility,
  type ConsentMode,
  type ConsentSnapshot,
  type SkipReason,
} from "@/lib/analytics/purchase-policy";
import { buildPurchaseEvent, redactSensitive, resolveMetaConfig, sendMetaEvents, type MetaConfigResult } from "@/lib/analytics/server-events";

/**
 * Server-side ad-platform event lifecycle (Meta Conversions API).
 *
 *   order enters CONFIRMED  ->  enqueuePurchaseEvent  ->  TrackingEventLog row (PENDING)
 *                                                    ->  deliverTrackingEvent: claim -> re-read the ORDER -> checks -> send -> SENT / retry / FAILED / SKIPPED
 *
 * Properties this file guarantees (each is covered by tests/services/tracking-event.test.ts):
 *  - Exactly one Purchase row per order (unique key + createMany skipDuplicates); the event id is purchase_<orderNumber>.
 *  - A row is claimed by exactly one worker at a time (guarded updateMany); a crashed claim becomes re-claimable after SENDING_STALE_MS.
 *  - What is sent is rebuilt from the order in the DATABASE at delivery time, never from anything the browser submitted.
 *  - An order cancelled/refunded before delivery is SKIPPED, not sent. Already-accepted events are never "un-sent".
 *  - Nothing in here throws to its caller: tracking can never break an order operation.
 *  - Rows, logs and errors hold no email/phone/name/token.
 */

const DESTINATION = "META_CAPI";
const EVENT = "Purchase";
/** The admin's click waits at most this long for delivery; anything slower continues/retries in the background. */
const HOOK_BUDGET_MS = 6_000;

export type DeliveryOutcome = "sent" | "retry_scheduled" | "failed" | "skipped" | "not_claimed" | "not_found";

type Db = typeof prisma;

async function getTrackingSettings(db: Db) {
  const s = await db.storeSettings.findFirst({ select: { metaPixelId: true, consentMode: true } });
  return { metaPixelId: s?.metaPixelId ?? null, consentMode: (s?.consentMode ?? "OFF") as ConsentMode };
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
 * Records that this order's Purchase is due. Idempotent. Creates nothing when Meta is not configured (there is nothing to deliver
 * and no audit value in rows for a store that does not use Meta); the sweep picks such orders up if Meta is configured later and the
 * confirmation is still inside Meta's 7-day window.
 */
export async function enqueuePurchaseEvent(orderId: string, opts: { eventTime?: Date; db?: Db } = {}): Promise<{ logId: string | null; reason?: SkipReason | "already_queued" }> {
  const db = opts.db ?? prisma;
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, channelId: true } });
  if (!order) return { logId: null, reason: "order_not_eligible" };
  const eligibility = purchaseEligibility(order);
  if (!eligibility.eligible) return { logId: null, reason: eligibility.reason };

  const settings = await getTrackingSettings(db);
  if (!resolveMetaConfig(settings.metaPixelId).ok) return { logId: null, reason: "not_configured" };

  const eventTime = opts.eventTime ?? new Date();
  const created = await db.trackingEventLog.createMany({
    data: [{ destination: DESTINATION, eventName: EVENT, eventId: purchaseEventId(order.orderNumber), orderId: order.id, orderNumber: order.orderNumber, status: "PENDING", eventTime, nextAttemptAt: eventTime }],
    skipDuplicates: true,
  });
  const row = await db.trackingEventLog.findFirst({ where: { destination: DESTINATION, eventName: EVENT, orderId: order.id }, select: { id: true } });
  return { logId: row?.id ?? null, ...(created.count === 0 ? { reason: "already_queued" as const } : {}) };
}

// ------------------------------------------------------------------------------------------------------------------ deliver

async function scrubContactData(db: Db, orderId: string, now: Date) {
  await db.orderAttribution.updateMany({ where: { orderId, contactScrubbedAt: null }, data: { clientIp: null, clientUserAgent: null, contactScrubbedAt: now } });
}

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
      if (scrub) await scrubContactData(db, log.orderId, now);
      return "skipped" as const;
    };

    // 2. The ORDER is the source of truth: re-read it now.
    const order = await db.order.findUnique({
      where: { id: log.orderId },
      select: {
        id: true, orderNumber: true, status: true, channelId: true, total: true, currency: true, email: true, phone: true, userId: true, shippingSnapshot: true,
        items: { select: { productId: true, quantity: true, unitPrice: true } },
      },
    });
    if (!order) return await skip("order_not_eligible", true);
    const eligibility = purchaseEligibility(order);
    if (!eligibility.eligible) return await skip(eligibility.reason, true);

    // 3. Consent: what the visitor decided at checkout, judged against the CURRENT store mode.
    const settings = await getTrackingSettings(db);
    const attribution = await db.orderAttribution.findUnique({ where: { orderId: order.id } });
    const snapshot = (attribution?.consentState ?? "UNKNOWN") as ConsentSnapshot;
    if (!mayDeliverServerEvent(settings.consentMode, snapshot)) return await skip("consent_not_granted", true);

    // 4. Meta's 7-day window.
    if (isEventTooOld(log.eventTime, now.getTime())) return await skip("event_too_old", true);

    // 5. Configuration (recoverable: the sweep re-queues these once Meta is configured).
    const cfg: MetaConfigResult = resolveMetaConfig(settings.metaPixelId);
    if (!cfg.ok) return await skip("not_configured", false);

    // 6. Build from server data and send.
    const shipping = (order.shippingSnapshot ?? {}) as { fullName?: string; city?: string; country?: string };
    const origin = await siteOrigin();
    const event = buildPurchaseEvent({
      order: {
        orderNumber: order.orderNumber,
        total: Number(order.total),
        currency: order.currency,
        email: order.email,
        phone: order.phone,
        userId: order.userId,
        shipping: { fullName: shipping.fullName, city: shipping.city, country: shipping.country },
        items: order.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: Number(i.unitPrice) })),
      },
      eventId: log.eventId,
      eventTime: log.eventTime,
      sourceUrl: `${origin}/checkout`,
      attribution: { fbc: attribution?.fbc, fbp: attribution?.fbp, ip: attribution?.clientIp, userAgent: attribution?.clientUserAgent },
      now: now.getTime(),
    });
    const result = await sendMetaEvents(cfg.config, [event], { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });

    if (result.ok) {
      await finish({ status: "SENT", sentAt: now, httpStatus: result.httpStatus, fbtraceId: result.fbtraceId ?? null, apiVersion: cfg.config.apiVersion, nextAttemptAt: null, errorCode: null, errorMessage: null, skipReason: null });
      await scrubContactData(db, order.id, now); // IP / user agent are only needed until delivery
      return "sent";
    }

    const errorFields = { httpStatus: result.httpStatus ?? null, errorCode: result.code ?? null, errorMessage: result.message, fbtraceId: result.fbtraceId ?? null, apiVersion: cfg.config.apiVersion };
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

/**
 * Called by adminUpdateOrderStatus AFTER the status change has committed. Awaits delivery for a short budget so the common case
 * completes immediately; anything slower is finished by the retry job. Never throws, never blocks longer than HOOK_BUDGET_MS.
 */
export async function trackOrderConfirmed(orderId: string): Promise<void> {
  try {
    const queued = await enqueuePurchaseEvent(orderId);
    if (!queued.logId || queued.reason === "already_queued") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HOOK_BUDGET_MS);
    });
    try {
      await Promise.race([deliverTrackingEvent(queued.logId).then(() => undefined), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    console.error("[tracking] could not record the confirmed-order event");
  }
}

// ------------------------------------------------------------------------------------------------------------------ maintenance

export type MaintenanceSummary = { queued: number; requeued: number; delivered: Record<DeliveryOutcome, number>; scrubbed: number };

/**
 * Run by the scheduled job (and the admin "Run now" button):
 *  1. enqueue confirmed website orders (last ~7 days) that have no event row (a crash between commit and enqueue, or Meta configured later);
 *  2. re-queue rows skipped only because Meta was not configured, if it is now;
 *  3. deliver due rows;
 *  4. remove IP / user agent from attributions whose event window has closed.
 */
export async function runTrackingMaintenance(opts: { now?: Date; fetchImpl?: typeof fetch; batch?: number; db?: Db } = {}): Promise<MaintenanceSummary> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 25;
  const summary: MaintenanceSummary = { queued: 0, requeued: 0, delivered: { sent: 0, retry_scheduled: 0, failed: 0, skipped: 0, not_claimed: 0, not_found: 0 }, scrubbed: 0 };
  const settings = await getTrackingSettings(db);
  const configured = resolveMetaConfig(settings.metaPixelId).ok;
  const cutoff = new Date(now.getTime() - META_MAX_EVENT_AGE_MS);

  if (configured) {
    const candidates = await db.order.findMany({
      where: { channelId: WEBSITE_CHANNEL_ID, status: { in: [...PURCHASE_ELIGIBLE_STATUSES] }, trackingEvents: { some: { status: "CONFIRMED", createdAt: { gte: cutoff } } } },
      select: { id: true, trackingEvents: { where: { status: "CONFIRMED" }, select: { createdAt: true } }, trackingEventLogs: { select: { eventName: true, destination: true } } },
      take: batch * 4,
    });
    for (const o of candidates) {
      if (summary.queued >= batch) break;
      if (o.trackingEventLogs.some((l) => l.eventName === EVENT && l.destination === DESTINATION)) continue;
      const confirmedAt = o.trackingEvents.map((e) => e.createdAt).sort((a, b) => a.getTime() - b.getTime())[0];
      const r = await enqueuePurchaseEvent(o.id, { eventTime: confirmedAt, db });
      if (r.logId && r.reason !== "already_queued") summary.queued += 1;
    }
    const reopened = await db.trackingEventLog.updateMany({
      where: { destination: DESTINATION, eventName: EVENT, status: "SKIPPED", skipReason: "not_configured", eventTime: { gte: cutoff } },
      data: { status: "PENDING", nextAttemptAt: now, skipReason: null },
    });
    summary.requeued = reopened.count;
  }

  const due = await db.trackingEventLog.findMany({
    where: {
      destination: DESTINATION,
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
    data: { clientIp: null, clientUserAgent: null, contactScrubbedAt: now },
  });
  summary.scrubbed = scrubbed.count;
  return summary;
}

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
