/**
 * The shipment status timeline an admin reads on the order page: booking attempts (created / rejected / unconfirmed), hand-entered details,
 * "the courier confirmed a parcel exists" recoveries, and every webhook / poll status. Pure: rows in, display entries out.
 * It carries no customer data and no secret: only what CourierShipmentEvent stores (statuses, a sanitised note, the consignment id).
 */
import { COURIER_EVENT_LABEL } from "@/lib/courier/status";
import type { CourierEvent } from "@/lib/courier/types";

export type TimelineRow = {
  id: string;
  provider: string;
  consignmentId: string | null;
  source: string;
  rawStatus: string;
  mappedEvent: string;
  outcome: string;
  note: string | null;
  providerEventAt: Date | null;
  createdAt: Date;
};

export type TimelineTone = "ok" | "warn" | "error" | "neutral";

export type TimelineEntry = {
  id: string;
  at: Date;
  kind: "booking" | "manual" | "recovery" | "status";
  title: string;
  detail: string | null;
  provider: string;
  tone: TimelineTone;
  /** Only for status updates: whether it changed the order, was a repeat, or was an older update that was ignored. */
  outcomeLabel: string | null;
};

const OUTCOME_LABEL: Record<string, string> = { APPLIED: "order updated", RECORDED: "recorded", STALE: "older update, ignored", DUPLICATE: "repeat" };
const isEvent = (v: string): v is CourierEvent => v in COURIER_EVENT_LABEL;
const toneOf = (e: string): TimelineTone =>
  e === "DELIVERED" ? "ok" : e === "PARTIAL_DELIVERED" ? "warn" : e === "CANCELLED" || e === "DELIVERY_FAILED" || e === "RETURNED" ? "error" : "neutral";

/** Newest first (ties broken by id so the order is stable). `labelOf` maps a provider key to its display name. */
export function buildShipmentTimeline(rows: TimelineRow[], labelOf: (providerKey: string) => string): TimelineEntry[] {
  const entries = rows.map((r): TimelineEntry => {
    const provider = labelOf(r.provider);
    const base = { id: r.id, at: r.createdAt, provider, outcomeLabel: null as string | null };
    const cid = r.consignmentId ? `Consignment ${r.consignmentId}` : null;
    switch (r.source) {
      case "BOOKING":
        return { ...base, kind: "booking", title: `Booked with ${provider}`, detail: r.note ?? cid, tone: "ok" };
      case "BOOKING_FAILED":
        return { ...base, kind: "booking", title: `${provider} rejected the booking`, detail: r.note ?? "Nothing was booked.", tone: "error" };
      case "BOOKING_UNCERTAIN":
        return { ...base, kind: "booking", title: `Booking with ${provider} is unconfirmed`, detail: r.note ?? "It may have gone through: check the courier portal before retrying.", tone: "warn" };
      case "MANUAL":
        return { ...base, kind: "manual", title: r.rawStatus === "manual_cleared" ? "Hand-entered courier details cleared" : `Courier details entered by hand (${provider})`, detail: r.note, tone: "neutral" };
      case "RECOVERY":
        return { ...base, kind: "recovery", title: `${provider} confirmed it already holds a parcel`, detail: `Its status: ${r.rawStatus.replaceAll("_", " ")}. Booking again is blocked.`, tone: "warn" };
      default: {
        const label = isEvent(r.mappedEvent) ? COURIER_EVENT_LABEL[r.mappedEvent] : "Status updated";
        return {
          ...base, kind: "status", title: `${provider}: ${r.rawStatus.replaceAll("_", " ")}`, detail: label === "Status updated" ? null : label,
          tone: r.outcome === "STALE" || r.outcome === "DUPLICATE" ? "neutral" : toneOf(r.mappedEvent), outcomeLabel: OUTCOME_LABEL[r.outcome] ?? r.outcome.toLowerCase(),
        };
      }
    }
  });
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
}
