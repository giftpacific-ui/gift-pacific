/**
 * THE Purchase policy (pure; one definition, unit-tested, documented in HANDOFF_GIFTPACIFIC.md).
 *
 * ## Trigger
 * A website order generates its Purchase when it ENTERS `CONFIRMED` through `adminUpdateOrderStatus` - the one function every
 * status change goes through (admin action and courier sync). `PENDING -> CONFIRMED` is the only transition that leads to
 * CONFIRMED, and that function refuses to confirm an order whose required advance is not VERIFIED (or waived) or whose low-trust
 * review is outstanding. So a "Purchase" means: *the merchant confirmed the order, and where an advance was required it was
 * verified*. This is the same for COD and prepaid orders. It is NOT "order created", and it does not wait for delivery.
 *
 * ## Never a Purchase
 * Orders that are only PENDING; orders from marketplace/external channels (they never pass through the website checkout and are
 * recorded by staff); orders that have since been CANCELLED / REFUNDED / REFUND_REQUESTED / FAILED_DELIVERY when the event is
 * (re)delivered. A Purchase that was already accepted before a later cancellation is NOT reversed (ad platforms have no standard
 * "un-purchase" event); the audit row shows what was sent and when.
 *
 * ## Exactly once
 * One TrackingEventLog row per (destination, event, order) is enforced by a unique index; the event id is derived from the order
 * number, so the browser and the server always agree.
 */
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";

export type ConsentMode = "OFF" | "OPT_IN";
export type ConsentSnapshot = "GRANTED" | "DENIED" | "UNKNOWN" | "NOT_REQUIRED";

/** First-party cookie mirroring the visitor's choice (localStorage is invisible to the server). */
export const CONSENT_COOKIE = "gp_consent";

/** Statuses an order may be in for its Purchase to be (re)delivered. */
export const PURCHASE_ELIGIBLE_STATUSES = ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;

export type SkipReason =
  | "not_website_order"
  | "order_not_eligible"
  | "consent_not_granted"
  | "event_too_old"
  | "not_configured";

export function purchaseEligibility(order: { status: string; channelId: string }): { eligible: true } | { eligible: false; reason: SkipReason } {
  if (order.channelId !== WEBSITE_CHANNEL_ID) return { eligible: false, reason: "not_website_order" };
  if (!(PURCHASE_ELIGIBLE_STATUSES as readonly string[]).includes(order.status)) return { eligible: false, reason: "order_not_eligible" };
  return { eligible: true };
}

/** What the server can know about consent when the order was placed. OFF = the store does not ask (documented default). */
export function consentSnapshotFor(mode: ConsentMode, cookieValue: string | null | undefined): ConsentSnapshot {
  if (mode === "OFF") return "NOT_REQUIRED";
  if (cookieValue === "granted") return "GRANTED";
  if (cookieValue === "denied") return "DENIED";
  return "UNKNOWN";
}

/** May a tracker run / may data be stored for this snapshot? Under OPT_IN only an explicit grant counts. */
export const isTrackingPermitted = (snapshot: ConsentSnapshot): boolean => snapshot === "GRANTED" || snapshot === "NOT_REQUIRED";

/**
 * The server decision when the event is finally sent. The CURRENT store mode decides whether consent matters at all: if an
 * admin has since switched to OPT_IN, an order captured without a grant is not sent; if the store has gone back to OFF, the
 * stored snapshot no longer blocks.
 */
export function mayDeliverServerEvent(mode: ConsentMode, snapshot: ConsentSnapshot): boolean {
  return mode === "OFF" ? snapshot !== "DENIED" : snapshot === "GRANTED";
}

// ----------------------------------------------------------------------------------------------------------- retry policy

/** Meta rejects server events whose event_time is more than 7 days old. A safety margin is kept. */
export const META_MAX_EVENT_AGE_MS = 7 * 86_400_000 - 3_600_000;
export const MAX_DELIVERY_ATTEMPTS = 6;
/** A claim (SENDING) older than this is assumed abandoned (crashed worker) and may be re-claimed. */
export const SENDING_STALE_MS = 2 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;

/** Delay before the next attempt after `attempt` failed attempts (1-based). null = give up. */
export function nextRetryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return null;
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}

export const isEventTooOld = (eventTime: Date, now: number): boolean => now - eventTime.getTime() > META_MAX_EVENT_AGE_MS;

/** The browser Purchase and the server event share this id (defined once, in ids.ts) so the destination can de-duplicate them. */
export { purchaseEventId } from "@/lib/analytics/ids";
