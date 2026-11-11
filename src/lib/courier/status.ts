/**
 * Pure courier rules: provider-status → order-status planning, booking
 * eligibility, phone normalization, error sanitizing and webhook auth.
 *
 * The mapping NEVER yields CANCELLED, REFUNDED or REFUND_REQUESTED — those
 * are the only statuses that move stock, and that decision stays with a
 * human. Courier events therefore cannot deduct or restore stock; they can
 * only walk the order forward through transitions the policy already allows.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ORDER_STATUS_TRANSITIONS, type OrderStatusName } from "@/lib/order-transitions";
import type { CourierEvent } from "@/lib/courier/types";

const NEVER_AUTOMATIC: readonly OrderStatusName[] = ["CANCELLED", "REFUNDED", "REFUND_REQUESTED"];
const MAX_HOPS = 3;

function bfsPath(from: OrderStatusName, to: OrderStatusName): OrderStatusName[] | null {
  if (from === to) return [];
  const queue: { status: OrderStatusName; path: OrderStatusName[] }[] = [{ status: from, path: [] }];
  const seen = new Set<OrderStatusName>([from]);
  while (queue.length > 0) {
    const { status, path } = queue.shift()!;
    if (path.length >= MAX_HOPS) continue;
    for (const next of ORDER_STATUS_TRANSITIONS[status]) {
      if (seen.has(next) || NEVER_AUTOMATIC.includes(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ status: next, path: nextPath });
    }
  }
  return null;
}

/**
 * Which order-status steps (each individually validated by the transition
 * policy when applied) a courier event should cause from `current`.
 * Empty = nothing to do (stale, duplicate, or not applicable).
 */
export function planOrderTransitions(current: OrderStatusName, event: CourierEvent): OrderStatusName[] {
  switch (event) {
    case "PICKED_UP":
      return bfsPath(current, "SHIPPED") ?? [];
    case "OUT_FOR_DELIVERY":
      return bfsPath(current, "OUT_FOR_DELIVERY") ?? [];
    case "DELIVERED":
      return bfsPath(current, "DELIVERED") ?? [];
    case "DELIVERY_FAILED":
    case "RETURNED":
      // Only meaningful once the parcel is actually out with the courier.
      return current === "SHIPPED" || current === "OUT_FOR_DELIVERY" ? ["FAILED_DELIVERY"] : [];
    default:
      return [];
  }
}

export const COURIER_EVENT_LABEL: Record<CourierEvent, string> = {
  PENDING: "Awaiting pickup",
  PICKED_UP: "Picked up by courier",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  DELIVERY_FAILED: "Delivery attempt failed",
  RETURNED: "Returned to sender",
  UNKNOWN: "Status updated",
};

// ---------------------------------------------------------------------------
// Booking eligibility
// ---------------------------------------------------------------------------

export const BOOKABLE_ORDER_STATUSES: readonly OrderStatusName[] = ["CONFIRMED", "PROCESSING"];
/** A BOOKING claim older than this is assumed to belong to a crashed request. */
export const STALE_BOOKING_MS = 10 * 60 * 1000;

export type BookingOrderView = {
  status: OrderStatusName;
  paymentMethod: string;
  paymentStatus: string;
  total: number;
  /** VERIFIED advance already received; the courier collects only the rest. */
  advancePaid?: number;
  courierBookingStatus: "NOT_BOOKED" | "BOOKING" | "BOOKED" | "FAILED" | "UNCERTAIN" | "MANUAL";
  courierBookingStartedAt: Date | null;
  recipient: { name: string; phone: string; address: string } | null;
};

export type Eligibility =
  | { ok: true; codAmount: number; phone: string; address: string; name: string }
  | { ok: false; code: "not_bookable_status" | "not_cod" | "already_booked" | "manual" | "in_progress" | "needs_confirmation" | "bad_recipient"; message: string };

/** "+8801711000000" / "8801711000000" / "01711000000" → "01711000000"; else null. */
export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, "");
  const m = digits.match(/^(?:\+?88)?(01[3-9]\d{8})$/);
  return m ? m[1] : null;
}

export function checkBookingEligibility(
  order: BookingOrderView,
  now: Date,
  opts: { confirmUncertain?: boolean } = {},
): Eligibility {
  if (!BOOKABLE_ORDER_STATUSES.includes(order.status)) {
    return { ok: false, code: "not_bookable_status", message: "Only Confirmed or Processing orders can be booked with a courier." };
  }
    // COD (website) and MARKETPLACE (an external order we ship ourselves) can be booked. For a
  // marketplace order that is already PAID the COD amount below is 0; unpaid => collect the total.
  if (order.paymentMethod !== "COD" && order.paymentMethod !== "MARKETPLACE") {
    return { ok: false, code: "not_cod", message: "Only Cash on Delivery and marketplace orders are supported." };
  }
  switch (order.courierBookingStatus) {
    case "BOOKED":
      return { ok: false, code: "already_booked", message: "This order is already booked with the courier." };
    case "MANUAL":
      return { ok: false, code: "manual", message: "Courier details were entered manually for this order." };
    case "BOOKING": {
      const startedAt = order.courierBookingStartedAt?.getTime() ?? 0;
      if (now.getTime() - startedAt < STALE_BOOKING_MS) {
        return { ok: false, code: "in_progress", message: "A booking request is already in progress." };
      }
      if (!opts.confirmUncertain) {
        return { ok: false, code: "needs_confirmation", message: "A previous booking attempt never finished. Check the courier portal, then confirm to retry." };
      }
      break;
    }
    case "UNCERTAIN":
      if (!opts.confirmUncertain) {
        return { ok: false, code: "needs_confirmation", message: "The last attempt may have reached the courier. Check the courier portal for this order, then confirm to retry." };
      }
      break;
    default:
      break;
  }

  const recipient = order.recipient;
  const phone = recipient ? normalizeBdPhone(recipient.phone) : null;
  const name = recipient?.name.trim() ?? "";
  const address = recipient?.address.replace(/\s+/g, " ").trim() ?? "";
  if (!recipient || name.length < 2 || !phone || address.length < 5) {
    return { ok: false, code: "bad_recipient", message: "The order needs a recipient name, a valid Bangladeshi mobile number and an address." };
  }
  const codAmount = order.paymentStatus === "PAID" ? 0 : Math.max(0, Math.round((order.total - (order.advancePaid ?? 0)) * 100) / 100);
  return { ok: true, codAmount, phone, address: address.slice(0, 250), name: name.slice(0, 100) };
}

/** Builds the booking recipient from an order's shipping snapshot (untrusted JSON). */
export function recipientFromSnapshot(
  snapshot: unknown,
  fallbackPhone: string,
): { name: string; phone: string; address: string } | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const s = snapshot as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const parts = [str(s.line1), str(s.line2), str(s.city), str(s.state), str(s.postalCode)].filter(Boolean);
  return {
    name: str(s.fullName),
    phone: str(s.phone) || fallbackPhone,
    address: parts.join(", "),
  };
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

/** Provider text shown to admins: bounded, printable, with our secrets masked. */
export function sanitizeProviderMessage(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out.slice(0, 300);
}

/** Constant-time check of an `Authorization: Bearer <secret>` header. */
export function verifyBearerSecret(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (!header || !secret) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
