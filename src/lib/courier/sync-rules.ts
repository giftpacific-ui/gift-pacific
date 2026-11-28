/**
 * Pure rules for shipment-status synchronisation and booking readiness. No I/O: everything here is unit-tested directly and
 * shared by the webhook, the scheduled poll, the manual refresh and the admin panel, so they can never disagree.
 */
import type { Eligibility } from "@/lib/courier/status";

export type StoredCourierState = { rawStatus: string | null; eventAt: Date | null };
export type IncomingCourierEvent = { rawStatus: string; eventAt: Date | null };
export type Precedence = { decision: "apply" | "duplicate" | "stale"; reason: string };

/**
 * Whether an incoming provider status may replace the stored one.
 *  1. Nothing stored yet                                   → apply.
 *  2. Same raw status as stored                            → duplicate (a repeat; nothing changes).
 *  3. Both carry a trusted provider time:
 *       older than stored → stale (an out-of-order delivery must never overwrite a newer fact);
 *       newer than stored → apply (even to a lower rank: a provider can legitimately revert, e.g. reject an approval).
 *  4. Otherwise rank decides: a lower rank never overrides a higher one, and an unrankable (unrecognised) status never overrides a status that
 *     is awaiting approval or final (rank >= 2) - but it MAY replace an in-progress one (rank <= 1), so a status the provider adds later stays
 *     visible for diagnostics instead of being hidden behind "in review" forever.
 * "stale" events are still recorded (diagnostics) but change neither the stored status nor the order.
 */
export function decideEventPrecedence(prev: StoredCourierState, next: IncomingCourierEvent, rank: (raw: string) => number | null): Precedence {
  if (prev.rawStatus === null) return { decision: "apply", reason: "first status" };
  if (next.rawStatus === prev.rawStatus) return { decision: "duplicate", reason: "same status as recorded" };
  if (prev.eventAt && next.eventAt) {
    if (next.eventAt.getTime() < prev.eventAt.getTime()) return { decision: "stale", reason: "older than the recorded event" };
    if (next.eventAt.getTime() > prev.eventAt.getTime()) return { decision: "apply", reason: "newer than the recorded event" };
  }
  const rn = rank(next.rawStatus);
  const rp = rank(prev.rawStatus);
  if (rn === null) {
    return rp === null || rp <= 1
      ? { decision: "apply", reason: "unrecognised status replaces an in-progress one" }
      : { decision: "stale", reason: "unrecognised status cannot override an approval-pending or final status" };
  }
  if (rp !== null && rn < rp) return { decision: "stale", reason: "lower progress than the recorded status" };
  return { decision: "apply", reason: "equal or higher progress" };
}

/** Idempotency key for a provider notification that carries a trusted time; null when the time is unknown (see decideEventPrecedence). */
export function eventDedupeKey(provider: string, subject: string, rawStatus: string, providerEventAt: Date | null | undefined): string | null {
  if (!providerEventAt) return null;
  return `${provider}:${subject}:${rawStatus}:${providerEventAt.toISOString()}`.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Booking readiness: every reason an order cannot be booked, not just the first one
// ---------------------------------------------------------------------------

export type BlockerCode =
  | "provider_unavailable" | "marketplace_fulfilled" | "not_bookable_status" | "not_cod" | "already_booked" | "manual" | "in_progress"
  | "needs_confirmation" | "remote_confirmed" | "bad_recipient" | "dispatch_gate" | "procurement";

export type Blocker = {
  code: BlockerCode;
  message: string;
  /** soft = an admin can explicitly clear it from the order page (checked the courier portal); hard = it must be fixed first. */
  soft: boolean;
};

export type ReadinessInput = {
  eligibility: Eligibility;
  /** dispatchBlockedReason(): advance verification, low-trust review, fraud review. null = clear. */
  gateReason: string | null;
  procurementOutstanding: number;
  marketplaceFulfilled: boolean;
  apiAvailable: boolean;
  apiProblem: string | null;
  /** The provider has positively confirmed it already holds a parcel for this order. */
  remoteConfirmed: boolean;
};

export type Readiness = { blockers: Blocker[]; canBook: boolean; needsConfirmation: boolean };

export function computeBookingReadiness(i: ReadinessInput): Readiness {
  const blockers: Blocker[] = [];
  if (!i.apiAvailable) blockers.push({ code: "provider_unavailable", message: i.apiProblem ?? "Courier booking is not configured.", soft: false });
  if (i.marketplaceFulfilled) blockers.push({ code: "marketplace_fulfilled", message: "This order is fulfilled by the marketplace, so it cannot be booked with a courier here.", soft: false });
  if (!i.eligibility.ok) blockers.push({ code: i.eligibility.code === "needs_confirmation" ? "needs_confirmation" : i.eligibility.code, message: i.eligibility.message, soft: i.eligibility.code === "needs_confirmation" });
  if (i.remoteConfirmed) blockers.push({ code: "remote_confirmed", message: "The courier has confirmed it already holds a parcel for this order. Do not book again: wait for its status update, or enter the courier details by hand.", soft: false });
  if (i.gateReason) blockers.push({ code: "dispatch_gate", message: i.gateReason, soft: false });
  if (i.procurementOutstanding > 0) blockers.push({ code: "procurement", message: "Some units of this order are still waiting to be sourced, so it cannot be booked with a courier yet.", soft: false });
  const hard = blockers.filter((b) => !b.soft);
  return { blockers, canBook: hard.length === 0, needsConfirmation: blockers.some((b) => b.code === "needs_confirmation") };
}
