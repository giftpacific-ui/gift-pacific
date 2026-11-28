/**
 * The shipment timeline an admin reads on the order page. Pure: rows in, display entries out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShipmentTimeline, type TimelineRow } from "@/lib/courier/timeline";

const label = (k: string) => ({ steadfast: "Steadfast", pathao: "Pathao", manual: "Manual entry" }[k] ?? k);
let n = 0;
const row = (o: Partial<TimelineRow>): TimelineRow => ({
  id: `e${++n}`, provider: "steadfast", consignmentId: null, source: "WEBHOOK", rawStatus: "pending", mappedEvent: "PENDING", outcome: "APPLIED",
  note: null, providerEventAt: null, createdAt: new Date("2026-11-20T10:00:00Z"), ...o,
});
const at = (h: number) => new Date(Date.UTC(2026, 10, 20, h));

test("newest first, ties broken by id so the order is stable", () => {
  const rows = [row({ id: "a", createdAt: at(1) }), row({ id: "c", createdAt: at(3) }), row({ id: "b", createdAt: at(3) })];
  assert.deepEqual(buildShipmentTimeline(rows, label).map((e) => e.id), ["c", "b", "a"]);
  assert.deepEqual(buildShipmentTimeline([...rows].reverse(), label).map((e) => e.id), ["c", "b", "a"]);
});

test("a created booking, a rejected booking and an unconfirmed booking read differently and honestly", () => {
  const [created, rejected, unconfirmed] = buildShipmentTimeline([
    row({ source: "BOOKING", consignmentId: "C-9", createdAt: at(3) }),
    row({ source: "BOOKING_FAILED", note: "invalid phone", createdAt: at(2) }),
    row({ source: "BOOKING_UNCERTAIN", note: null, createdAt: at(1) }),
  ], label);
  assert.deepEqual([created.title, created.tone, created.detail], ["Booked with Steadfast", "ok", "Consignment C-9"]);
  assert.deepEqual([rejected.title, rejected.tone, rejected.detail], ["Steadfast rejected the booking", "error", "invalid phone"]);
  assert.equal(unconfirmed.title, "Booking with Steadfast is unconfirmed");
  assert.equal(unconfirmed.tone, "warn");
  assert.match(unconfirmed.detail ?? "", /check the courier portal before retrying/i);
});

test("a rejection without a note still says nothing was booked", () => {
  assert.equal(buildShipmentTimeline([row({ source: "BOOKING_FAILED" })], label)[0].detail, "Nothing was booked.");
});

test("hand entries: entered, and cleared, with the provider named (including a courier that has no adapter)", () => {
  const [cleared, entered] = buildShipmentTimeline([
    row({ source: "MANUAL", provider: "pathao", rawStatus: "manual_entered", note: "Entered by hand: tracking P-1.", createdAt: at(1) }),
    row({ source: "MANUAL", provider: "pathao", rawStatus: "manual_cleared", createdAt: at(2) }),
  ], label);
  assert.equal(entered.title, "Courier details entered by hand (Pathao)");
  assert.equal(entered.kind, "manual");
  assert.equal(entered.detail, "Entered by hand: tracking P-1.");
  assert.equal(cleared.title, "Hand-entered courier details cleared");
});

test("a recovery says the courier holds a parcel and that booking again is blocked", () => {
  const e = buildShipmentTimeline([row({ source: "RECOVERY", rawStatus: "in_review" })], label)[0];
  assert.equal(e.kind, "recovery");
  assert.equal(e.tone, "warn");
  assert.match(e.title, /confirmed it already holds a parcel/);
  assert.match(e.detail ?? "", /in review/);
  assert.match(e.detail ?? "", /Booking again is blocked/);
});

test("courier status updates: tone follows the event, stale and repeated updates are neutral and labelled", () => {
  const rows = [
    row({ rawStatus: "delivered", mappedEvent: "DELIVERED", createdAt: at(5) }),
    row({ rawStatus: "partial_delivered", mappedEvent: "PARTIAL_DELIVERED", createdAt: at(4) }),
    row({ rawStatus: "cancelled", mappedEvent: "CANCELLED", createdAt: at(3) }),
    row({ rawStatus: "in_review", mappedEvent: "PENDING", outcome: "STALE", createdAt: at(2) }),
    row({ rawStatus: "pending", mappedEvent: "PENDING", outcome: "DUPLICATE", createdAt: at(1) }),
  ];
  const [d, p, c, stale, dup] = buildShipmentTimeline(rows, label);
  assert.deepEqual([d.tone, p.tone, c.tone], ["ok", "warn", "error"]);
  assert.equal(d.title, "Steadfast: delivered");
  assert.equal(d.outcomeLabel, "order updated");
  assert.equal(stale.tone, "neutral");
  assert.equal(stale.outcomeLabel, "older update, ignored");
  assert.equal(dup.outcomeLabel, "repeat");
});

test("an unknown event name never crashes the timeline", () => {
  const e = buildShipmentTimeline([row({ mappedEvent: "SOMETHING_NEW", rawStatus: "weird_status" })], label)[0];
  assert.equal(e.title, "Steadfast: weird status");
  assert.equal(e.detail, null);
});

test("the timeline carries no customer data or secrets: only what the event row stores", () => {
  const e = buildShipmentTimeline([row({ source: "BOOKING_FAILED", note: "invalid phone" })], label)[0];
  assert.deepEqual(Object.keys(e).sort(), ["at", "detail", "id", "kind", "outcomeLabel", "provider", "title", "tone"]);
});

test("an unknown provider key is shown as it is (never hidden, never a crash)", () => {
  assert.equal(buildShipmentTimeline([row({ source: "BOOKING", provider: "unknown" })], label)[0].title, "Booked with unknown");
});
