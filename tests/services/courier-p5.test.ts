/**
 * P5 courier operations against the real services (in-memory fake DB, MOCKED provider). Nothing here calls Steadfast.
 * Covers: eligibility gates, duplicate / concurrent booking, uncertain-booking recovery, webhook auth / replay / ordering, status mapping,
 * the "delivered is not PAID" rule, COD reconciliation + audit, the scheduled job, customer-visible data, and P3/P3.1 regressions.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, getOrderByNumberForCurrentUser, placeOrder } from "@/server/services/order.service";
import {
  applyCourierStatus, bookOrderWithCourier, bulkBookOrders, getCourierPanel, handleCourierWebhook, listCourierAttention, listCourierShipments,
  reconcileCourier, recoverUncertainBooking, refreshCourierStatus, testCourierConnection, getCourierDiagnostics, SYNC_LEASE_MS, MIN_POLL_INTERVAL_MS,
} from "@/server/services/courier.service";
import { confirmCodCollection, listCodReconciliation, recordCodEntry, resolveCodDiscrepancy, codStateForOrder } from "@/server/services/courier-cod.service";
import { getCourierConfig } from "@/lib/courier/config";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import type { CourierBookingRequest, CourierBookingResult, CourierProvider } from "@/lib/courier/types";
import { bookCourierAction } from "@/server/actions/admin-courier.actions";

let db: FakeDb;
const SECRET = "wh-secret-0123456789";
const config = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY", COURIER_API_SECRET: "SEC", COURIER_WEBHOOK_SECRET: SECRET });

type Fake = CourierProvider & {
  bookCalls: number; requests: CourierBookingRequest[]; results: CourierBookingResult[]; statusToReturn: string; statusCalls: number;
  lookupCalls: number; lookupAnswer: "found" | "unknown"; fetchFails: boolean; gate?: Promise<void>;
};
const OK = (id = "C-1"): CourierBookingResult => ({ ok: true, consignmentId: id, trackingCode: `T-${id}`, trackingUrl: null, providerStatus: "in_review" });

function fakeProvider(results: CourierBookingResult[] = [OK()], opts: { lookup?: boolean } = {}): Fake {
  const real = createSteadfastProvider(config, (async () => ({ kind: "network", message: "unused" })) as never);
  const p: Fake = {
    ...real, key: "steadfast", displayName: "Steadfast", bookCalls: 0, requests: [], results, statusToReturn: "delivered", statusCalls: 0,
    lookupCalls: 0, lookupAnswer: "unknown", fetchFails: false,
    features: { ...real.features!, referenceLookup: Boolean(opts.lookup) },
    async book(r) { p.bookCalls++; p.requests.push(r); if (p.gate) await p.gate; return p.results[Math.min(p.bookCalls - 1, p.results.length - 1)]; },
    async fetchStatus() { p.statusCalls++; return p.fetchFails ? { ok: false, message: "down" } : { ok: true, status: p.statusToReturn }; },
    async lookupByReference() { p.lookupCalls++; return p.lookupAnswer === "found" ? { kind: "found", status: "in_review" } : { kind: "unknown", message: "no" }; },
  };
  return p;
}
const deps = (p: CourierProvider, now?: () => Date) => ({ provider: p, config, now });

beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); db.patch("product", "p-standard", { stock: 500 }); });
const row = (id: string) => db.get("order", id);
const events = (id: string) => db.rows("courierShipmentEvent").filter((e) => e.orderId === id);
const balance = (id: string) => db.rows("payment").filter((p) => p.orderId === id && p.kind === "BALANCE");

async function confirmedOrder(qty = 2, user = "cust") {
  await runAs({ sub: user }, () => addItemToCart({ productId: "p-standard", quantity: qty }));
  const o = await runAs({ sub: user }, () => placeOrder(emptyCheckout));
  await adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN);
  return o;
}
async function booked(p = fakeProvider(), qty = 2, user = "cust") {
  const o = await confirmedOrder(qty, user);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  return o;
}
const hook = (p: CourierProvider, body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  handleCourierWebhook({ authorization: auth, rawBody: typeof body === "string" ? body : JSON.stringify(body) }, deps(p));

// ---------------------------------------------------------------------------------------------------------------------------------------
// Booking eligibility and the existing advance / trust / fraud gates
// ---------------------------------------------------------------------------------------------------------------------------------------

test("REGRESSION: a verified advance reduces the COD amount sent to the courier (the booking used to ignore advancePaid)", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { advanceRequired: 500, advancePaid: 500, paymentStatus: "PARTIALLY_PAID" });
  const p = fakeProvider();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(p.requests[0].codAmount, Number(row(o.id).total) - 500);
});

test("gates: unverified advance, open low-trust review and open fraud review each block booking BEFORE any provider call", async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["advance", { advanceRequired: 500, advancePaid: 0, advanceWaivedById: null }, /advance/i],
    ["trust", { trustReviewRequired: true, trustReviewedAt: null }, /review/i],
    ["fraud", { riskReviewRequired: true, riskLevel: "HIGH", riskReviewDecision: null }, /fraud/i],
  ];
  for (const [name, patch, re] of cases) {
    const o = await confirmedOrder(1, `u-${name}`);
    db.patch("order", o.id, patch);
    const p = fakeProvider();
    await assert.rejects(() => bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), re, name);
    assert.equal(p.bookCalls, 0, name);
    assert.equal(row(o.id).courierBookingStatus, "NOT_BOOKED", name);
  }
});

test("a fraud approval can never bypass the advance check", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { advanceRequired: 500, advancePaid: 0, advanceWaivedById: null, riskReviewRequired: true, riskLevel: "HIGH", riskReviewDecision: "APPROVED", riskReviewedLevel: "HIGH" });
  const p = fakeProvider();
  await assert.rejects(() => bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /advance/i);
  assert.equal(p.bookCalls, 0);
  db.patch("order", o.id, { advancePaid: 500 }); // advance verified -> now fine
  assert.equal((await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p))).booked, true);
});

test("not-eligible orders are refused on every path (service, bulk, server action); cancelled / refunded / pending / booked / bad address", async () => {
  // This test places many orders from one phone within seconds, which the P4 engine rightly scores as risky; the gates under test are patched in
  // directly below, so the automatic scoring is switched off for this fixture only.
  db.patch("storeSettings", "singleton", { fraudPolicy: { mode: "OFF" } });
  const p = fakeProvider();
  const pending = await runAs({ sub: "c1" }, async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder(emptyCheckout); });
  await assert.rejects(() => bookOrderWithCourier(pending.id, { actor: TEST_ADMIN }, deps(p)), /Confirmed or Processing/);
  for (const status of ["CANCELLED", "REFUNDED", "DELIVERED", "FAILED_DELIVERY"]) {
    const o = await confirmedOrder(1, `u-${status}`);
    db.patch("order", o.id, { status });
    await assert.rejects(() => bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /Confirmed or Processing/, status);
  }
  const badAddr = await confirmedOrder(1, "u-bad");
  db.patch("order", badAddr.id, { shippingSnapshot: { fullName: "X", phone: "123", line1: "a" } });
  await assert.rejects(() => bookOrderWithCourier(badAddr.id, { actor: TEST_ADMIN }, deps(p)), /recipient/i);
  const gated = await confirmedOrder(1, "u-gate");
  db.patch("order", gated.id, { advanceRequired: 100, advancePaid: 0 });
  const bulk = await bulkBookOrders([gated.id], deps(p), { actor: TEST_ADMIN });
  assert.equal(bulk[0].status, "skipped");
  assert.equal(p.bookCalls, 0);
  // the server action is the same gate, and a non-admin is refused before anything happens
  const viaAction = await runAs("admin", () => bookCourierAction(gated.id));
  assert.equal(viaAction.success, false);
  await assert.rejects(() => bookOrderWithCourier(gated.id, { actor: { adminId: "nobody" } }, deps(p)));
  assert.equal(p.bookCalls, 0);
});

test("admin panel shows EVERY reason an order cannot be booked, plus what would be sent when it can", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { advanceRequired: 500, advancePaid: 0, shippingSnapshot: { fullName: "J", phone: "123", line1: "x" } });
  const panel = await getCourierPanel(o.id, deps(fakeProvider()));
  assert.ok(panel);
  const codes = panel.blockers.map((b) => b.code);
  assert.ok(codes.includes("bad_recipient") && codes.includes("dispatch_gate"), codes.join());
  assert.equal(panel.canBook, false);
  assert.equal(panel.preview, null);

  const ok = await confirmedOrder(1, "c-ok");
  const good = await getCourierPanel(ok.id, deps(fakeProvider()));
  assert.ok(good && good.canBook && good.blockers.length === 0);
  assert.deepEqual([good.preview?.phone, good.preview?.codAmount], ["01711000000", Number(row(ok.id).total)]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Duplicate prevention and concurrency
// ---------------------------------------------------------------------------------------------------------------------------------------

test("concurrent single + bulk + action requests create exactly ONE consignment", async () => {
  const o = await confirmedOrder();
  let release!: () => void;
  const p = fakeProvider();
  p.gate = new Promise<void>((r) => { release = r; });
  const attempts = [
    bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)),
    bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)),
    bulkBookOrders([o.id], deps(p), { actor: TEST_ADMIN }),
    bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)),
  ].map((x) => x.then(() => "ok", () => "refused"));
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all(attempts);
  assert.equal(p.bookCalls, 1);
  assert.equal(row(o.id).courierBookingStatus, "BOOKED");
  assert.equal(db.rows("notification").filter((n) => n.dedupeKey === `courier:${o.id}:booked`).length, 1);
});

test("concurrent CONFIRMED retries of an UNCERTAIN booking still create at most one consignment", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  p.results = [OK("C-RETRY")];
  const before = p.bookCalls;
  await Promise.allSettled([1, 2, 3].map(() => bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, deps(p))));
  assert.equal(p.bookCalls - before, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Timeout / uncertain booking recovery
// ---------------------------------------------------------------------------------------------------------------------------------------

test("a timeout is UNCERTAIN, never auto-retried, and a plain retry is refused without the admin's confirmation", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "The courier did not answer in time." }]);
  const r = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(r.booked, false);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  assert.match(String(row(o.id).courierLastError), /did not answer/);
  await assert.rejects(() => bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /portal|confirm/i);
  assert.equal(p.bookCalls, 1);
  assert.equal(row(o.id).status, "CONFIRMED"); // the order itself is untouched
});

test("provider failure never touches payments, stock or order status", async () => {
  const o = await confirmedOrder();
  const stockBefore = db.get("product", "p-standard").stock;
  const paymentsBefore = JSON.stringify(db.rows("payment"));
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "boom" }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(db.get("product", "p-standard").stock, stockBefore);
  assert.equal(JSON.stringify(db.rows("payment")), paymentsBefore);
  assert.equal(row(o.id).status, "CONFIRMED");
});

test("recovery: when the courier CONFIRMS a parcel exists, any re-booking (even confirmed) is permanently refused", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }], { lookup: true });
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  p.lookupAnswer = "found";
  const rec = await recoverUncertainBooking(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(rec.outcome, "confirmed_exists");
  assert.ok(row(o.id).courierRemoteConfirmedAt instanceof Date);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  await assert.rejects(() => bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, deps(p)), /already holds a parcel/);
  assert.equal(p.bookCalls, 1);
  const panel = await getCourierPanel(o.id, deps(p));
  assert.ok(panel && !panel.canBook && panel.blockers.some((b) => b.code === "remote_confirmed"));
  assert.equal(events(o.id).filter((e) => e.source === "RECOVERY").length, 1);
});

test("recovery: an inconclusive answer changes nothing and is NEVER read as 'absent'", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }], { lookup: true });
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  const rec = await recoverUncertainBooking(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(rec.outcome, "unknown");
  assert.equal(row(o.id).courierRemoteConfirmedAt ?? null, null);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  // the explicit retry also asks first; inconclusive -> the admin's confirmation allows it
  p.results = [OK("C-2")];
  assert.equal((await bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, deps(p))).booked, true);
  assert.ok(p.lookupCalls >= 2);
});

test("recovery needs a courier that can answer, an unconfirmed booking, and an authorised actor", async () => {
  const o = await confirmedOrder();
  const noLookup = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(noLookup));
  await assert.rejects(() => recoverUncertainBooking(o.id, { actor: TEST_ADMIN }, deps(noLookup)), /not available/);
  await assert.rejects(() => recoverUncertainBooking(o.id, { actor: { adminId: "nobody" } }, deps(fakeProvider([OK()], { lookup: true }))));
  const fine = await booked();
  await assert.rejects(() => recoverUncertainBooking(fine.id, { actor: TEST_ADMIN }, deps(fakeProvider([OK()], { lookup: true }))), /unconfirmed/);
});

test("a webhook carrying the invoice + consignment heals an UNCERTAIN booking (adopts the id, clears the confirmation, stores COD)", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }], { lookup: true });
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  p.lookupAnswer = "found";
  await recoverUncertainBooking(o.id, { actor: TEST_ADMIN }, deps(p));
  const res = await hook(p, { consignment_id: 555, invoice: row(o.id).orderNumber, status: "in_review", cod_amount: 3670, updated_at: "2026-11-20T10:00:00Z" });
  assert.equal(res.status, 200);
  const r = row(o.id);
  assert.deepEqual([r.courierBookingStatus, r.courierConsignmentId, r.courierRemoteConfirmedAt, Number(r.courierCodAmount)], ["BOOKED", "555", null, 3670]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Webhooks: authentication, malformed input, replay, ordering
// ---------------------------------------------------------------------------------------------------------------------------------------

test("webhook authentication: unconfigured = 404, missing / wrong / look-alike token = 401, and nothing changes", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const body = { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "delivered" };
  assert.equal((await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify(body) }, { provider: p, config: getCourierConfig({}) })).status, 404);
  for (const auth of [null, "", "Bearer", "Bearer wrong", `Bearer ${SECRET}x`, `Basic ${SECRET}`, SECRET]) {
    assert.equal((await hook(p, body, auth)).status, 401, String(auth));
  }
  assert.equal(row(o.id).status, "CONFIRMED");
  assert.equal(events(o.id).filter((e) => e.source === "WEBHOOK").length, 0);
});

test("authenticated but malformed payloads are refused (400); acknowledged-but-ignored notices are 200; nothing changes either way", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  for (const bad of ["not json", "[]", "null", { status: "delivered" }, { consignment_id: "C-1" }, { consignment_id: "C-1", status: "x".repeat(70) }]) {
    assert.equal((await hook(p, bad)).status, 400, JSON.stringify(bad));
  }
  const ignored = await hook(p, { notification_type: "tracking_update", consignment_id: "C-1", status: "x" });
  assert.deepEqual([ignored.status, ignored.body.note], [200, "ignored"]);
  assert.equal((await hook(p, { consignment_id: "C-nope", status: "delivered" })).body.note, "unknown consignment");
  assert.equal(row(o.id).courierLastStatus, "in_review");
  assert.equal(row(o.id).status, "CONFIRMED");
});

test("a consignment id and invoice that point at different orders are not trusted", async () => {
  const p = fakeProvider();
  const a = await booked(p, fakeProvider([OK("C-A")]).bookCalls === 0 ? 1 : 1, "ua");
  const r = await hook(p, { consignment_id: "C-1", invoice: "SOME-OTHER-ORDER", status: "delivered" });
  assert.equal(r.body.note, "mismatch");
  assert.equal(row(a.id).status, "CONFIRMED");
});

test("duplicate webhook events: an exact replay is a no-op with ONE history row; the order moves once", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const body = { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "delivered", updated_at: "2026-11-20T10:00:00Z" };
  assert.equal((await hook(p, body)).body.note, "applied");
  for (let i = 0; i < 3; i++) assert.equal((await hook(p, body)).body.note, "duplicate");
  assert.equal(row(o.id).status, "DELIVERED");
  assert.equal(events(o.id).filter((e) => e.source === "WEBHOOK").length, 1);
  assert.equal(db.rows("orderTrackingEvent").filter((e) => e.orderId === o.id && e.status === "DELIVERED").length, 1);
  // concurrent identical deliveries too
  const o2 = await booked(fakeProvider([OK("C-2")]), 1, "u2");
  const body2 = { consignment_id: "C-2", invoice: row(o2.id).orderNumber, status: "delivered", updated_at: "2026-11-20T11:00:00Z" };
  await Promise.all([1, 2, 3, 4].map(() => hook(p, body2)));
  assert.equal(events(o2.id).filter((e) => e.source === "WEBHOOK").length, 1);
  assert.equal(db.rows("orderTrackingEvent").filter((e) => e.orderId === o2.id && e.status === "DELIVERED").length, 1);
});

test("out-of-order updates: an older event never overwrites a newer status (timestamped and untimestamped)", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const id = { consignment_id: "C-1", invoice: row(o.id).orderNumber };
  assert.equal((await hook(p, { ...id, status: "delivered", updated_at: "2026-11-20T10:00:00Z" })).body.note, "applied");
  const late = await hook(p, { ...id, status: "pending", updated_at: "2026-11-20T09:00:00Z" });
  assert.equal(late.body.note, "stale");
  assert.equal(row(o.id).courierLastStatus, "delivered");
  assert.equal(row(o.id).status, "DELIVERED");
  assert.equal(events(o.id).filter((e) => e.outcome === "STALE").length, 1);
  // a poll (no time) reading a lower status than the one recorded is stale too
  const p2 = fakeProvider(); p2.statusToReturn = "pending";
  const res = await applyCourierStatus(o.id, "in_review", p2);
  assert.deepEqual(res, { applied: false, reason: "stale" });
  assert.equal(row(o.id).courierLastStatus, "delivered");
});

test("out-of-order by TIME alone: a late-arriving OLDER 'delivered' cannot overwrite a newer 'pending' (rank would have allowed it)", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const id = { consignment_id: "C-1", invoice: row(o.id).orderNumber };
  await hook(p, { ...id, status: "pending", updated_at: "2026-11-20T12:00:00Z" });
  const late = await hook(p, { ...id, status: "delivered", updated_at: "2026-11-20T09:00:00Z" });
  assert.equal(late.body.note, "stale");
  assert.equal(row(o.id).courierLastStatus, "pending");
  assert.equal(row(o.id).status, "CONFIRMED");
  assert.equal(balance(o.id).length, 0);
});

test("STATIC GUARD: the booking query selects advancePaid (the fake DB ignores `select`, so only this guard can catch its removal)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/server/services/courier.service.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const bookingSelect = {"), src.indexOf("} as const;", src.indexOf("const bookingSelect = {")));
  assert.match(block, /advancePaid: true/);
});

test("a NEWER provider event may legitimately revert a raw status, yet never un-delivers or alters the order", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const id = { consignment_id: "C-1", invoice: row(o.id).orderNumber };
  await hook(p, { ...id, status: "delivered_approval_pending", updated_at: "2026-11-20T10:00:00Z" });
  assert.equal(row(o.id).status, "DELIVERED");
  await hook(p, { ...id, status: "pending", updated_at: "2026-11-20T12:00:00Z" });
  assert.equal(row(o.id).courierLastStatus, "pending");
  assert.equal(row(o.id).status, "DELIVERED");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Status mapping onto orders; the raw status is preserved; history; money is never touched by a courier
// ---------------------------------------------------------------------------------------------------------------------------------------

test("courier DELIVERED walks the order forward but NEVER records COD cash or marks it PAID", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "delivered" });
  assert.equal(row(o.id).status, "DELIVERED");
  assert.equal(balance(o.id).length, 0);
  assert.notEqual(row(o.id).paymentStatus, "PAID");
  assert.equal(row(o.id).courierLastStatus, "delivered"); // raw provider status preserved
  const state = await codStateForOrder(o.id);
  assert.equal(state?.status, "AWAITING_CONFIRMATION");
  assert.ok(state?.openFlags.some((f) => f.code === "COLLECTION_UNCONFIRMED"));
});

test("an ADMIN marking the order delivered still records the COD balance exactly as before (existing workflow preserved)", async () => {
  const o = await confirmedOrder();
  for (const s of ["PROCESSING", "SHIPPED", "DELIVERED"] as const) await adminUpdateOrderStatus(o.id, s, undefined, TEST_ADMIN);
  assert.equal(balance(o.id).length, 1);
  assert.equal(row(o.id).paymentStatus, "PAID");
});

test("manual status correction by an admin is not undone by later (stale) courier statuses", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  for (const s of ["PROCESSING", "SHIPPED", "FAILED_DELIVERY"] as const) await adminUpdateOrderStatus(o.id, s, "manual", TEST_ADMIN);
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "pending", updated_at: "2026-11-20T10:00:00Z" });
  assert.equal(row(o.id).status, "FAILED_DELIVERY");
});

test("PARTIAL delivery never completes the order: it is recorded, shown in history and put in front of an admin", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  await adminUpdateOrderStatus(o.id, "PROCESSING", undefined, TEST_ADMIN);
  await adminUpdateOrderStatus(o.id, "SHIPPED", undefined, TEST_ADMIN);
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "partial_delivered", cod_amount: 3670, updated_at: "2026-11-20T10:00:00Z" });
  assert.equal(row(o.id).status, "SHIPPED");
  assert.ok(db.rows("orderTrackingEvent").some((e) => e.orderId === o.id && /Partially delivered/.test(String(e.note))));
  const att = await listCourierAttention();
  assert.equal(att.find((a) => a.id === o.id)?.reason, "partial_delivery");
  const cod = await codStateForOrder(o.id);
  assert.ok(cod?.openFlags.some((f) => f.code === "PARTIAL_DELIVERY"));
});

test("courier cancelled: a shipped order becomes FAILED_DELIVERY (never CANCELLED); a not-yet-shipped one is flagged for an admin", async () => {
  const p = fakeProvider();
  const shipped = await booked(p);
  await adminUpdateOrderStatus(shipped.id, "PROCESSING", undefined, TEST_ADMIN);
  await adminUpdateOrderStatus(shipped.id, "SHIPPED", undefined, TEST_ADMIN);
  const stockBefore = db.get("product", "p-standard").stock;
  await hook(p, { consignment_id: "C-1", invoice: row(shipped.id).orderNumber, status: "cancelled" });
  assert.equal(row(shipped.id).status, "FAILED_DELIVERY");
  assert.equal(db.get("product", "p-standard").stock, stockBefore);

  const p2 = fakeProvider([OK("C-9")]);
  const idle = await booked(p2, 1, "u-idle");
  await hook(p2, { consignment_id: "C-9", invoice: row(idle.id).orderNumber, status: "cancelled" });
  assert.equal(row(idle.id).status, "CONFIRMED");
  assert.equal((await listCourierAttention()).find((a) => a.id === idle.id)?.reason, "courier_cancelled");
});

test("unknown / unrecognised provider statuses are stored raw and never move an order", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "brand_new_status" });
  assert.equal(row(o.id).courierLastStatus, "brand_new_status");
  assert.equal(row(o.id).status, "CONFIRMED");
});

test("manual refresh and scheduled poll use the same path; refresh results are idempotent", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  p.statusToReturn = "delivered";
  const first = await refreshCourierStatus(o.id, TEST_ADMIN, deps(p));
  assert.equal(first.applied, true);
  const second = await refreshCourierStatus(o.id, TEST_ADMIN, deps(p));
  assert.deepEqual(second, { applied: false, reason: "duplicate" });
  assert.ok(row(o.id).courierLastSyncAt instanceof Date);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// COD reconciliation
// ---------------------------------------------------------------------------------------------------------------------------------------

async function deliveredByCourier(p = fakeProvider()) {
  const o = await booked(p);
  await hook(p, { consignment_id: row(o.id).courierConsignmentId, invoice: row(o.id).orderNumber, status: "delivered", updated_at: "2026-11-20T10:00:00Z" });
  return o;
}

test("confirming collection is explicit, needs a reason, is audited and happens once; only then is the order PAID", async () => {
  const o = await deliveredByCourier();
  await assert.rejects(() => confirmCodCollection({ orderId: o.id, adminId: "a1", reason: "ok" }), /at least 10/);
  await assert.rejects(() => confirmCodCollection({ orderId: o.id, adminId: "nobody", reason: "checked the courier statement" }));
  assert.equal(balance(o.id).length, 0);
  await confirmCodCollection({ orderId: o.id, adminId: "a1", reason: "checked the courier statement line 14" });
  assert.equal(balance(o.id).length, 1);
  assert.equal(row(o.id).paymentStatus, "PAID");
  assert.ok(db.rows("adminAuditEvent").some((a) => a.action === "COURIER_COD_CONFIRMED" && a.entityId === o.id));
  await assert.rejects(() => confirmCodCollection({ orderId: o.id, adminId: "a1", reason: "checked the courier statement line 14" }), /already recorded/);
  assert.equal(balance(o.id).length, 1);
  const after = await codStateForOrder(o.id);
  assert.equal(after?.paymentRecorded, true);
  assert.equal(after?.status, "AWAITING_REPORT"); // recorded in our books, but the courier has not yet reported/settled its side
});

test("confirmation is refused for orders the courier has not delivered, non-COD orders, and while a shortfall is open", async () => {
  const p = fakeProvider();
  const notDelivered = await booked(p);
  await assert.rejects(() => confirmCodCollection({ orderId: notDelivered.id, adminId: "a1", reason: "a long enough reason" }), /delivered/);
  const o = await deliveredByCourier(fakeProvider([OK("C-5")]));
  await recordCodEntry({ orderId: o.id, adminId: "a1", kind: "COLLECTION_REPORTED", amount: 3000, reference: "STMT-1" });
  await assert.rejects(() => confirmCodCollection({ orderId: o.id, adminId: "a1", reason: "a long enough reason" }), /LESS cash/);
  assert.equal(balance(o.id).length, 0);
});

test("short / excess collection is detected; resolving needs a reason, the exact amount, is audited and never edits records", async () => {
  const o = await deliveredByCourier();
  const entriesBefore = JSON.stringify(db.rows("courierCodEntry"));
  await recordCodEntry({ orderId: o.id, adminId: "a1", kind: "COLLECTION_REPORTED", amount: 3000, reference: "STMT-1" });
  const st = await codStateForOrder(o.id);
  const short = st?.openFlags.find((f) => f.code === "SHORT_COLLECTION");
  assert.equal(short?.amount, 670);
  assert.equal(st?.status, "DISCREPANCY");
  const base = { orderId: o.id, adminId: "a1", flagCode: "SHORT_COLLECTION", amount: 670, action: "ACCEPTED_DIFFERENCE" };
  await assert.rejects(() => resolveCodDiscrepancy({ ...base, reason: "short" }), /at least 10/);
  await assert.rejects(() => resolveCodDiscrepancy({ ...base, amount: 100, reason: "agreed discount with customer" }), /changed since/);
  await assert.rejects(() => resolveCodDiscrepancy({ ...base, adminId: "nobody", reason: "agreed discount with customer" }));
  await assert.rejects(() => resolveCodDiscrepancy({ ...base, flagCode: "EXCESS_COLLECTION", reason: "agreed discount with customer" }), /no longer open/);
  const paymentsBefore = JSON.stringify(db.rows("payment"));
  await resolveCodDiscrepancy({ ...base, reason: "agreed discount with customer" });
  assert.ok(!(await codStateForOrder(o.id))?.openFlags.some((f) => f.code === "SHORT_COLLECTION"));
  assert.ok((await codStateForOrder(o.id))?.resolved.some((f) => f.code === "SHORT_COLLECTION"));
  await assert.rejects(() => resolveCodDiscrepancy({ ...base, reason: "agreed discount with customer" }), /no longer open|already resolved/);
  assert.equal(JSON.stringify(db.rows("payment")), paymentsBefore); // payment records untouched
  assert.equal(db.rows("courierCodEntry").length, JSON.parse(entriesBefore).length + 1); // only the new report; nothing rewritten
  const audit = db.rows("adminAuditEvent").find((a) => a.action === "COURIER_COD_RESOLVED");
  assert.ok(audit && JSON.stringify(audit.detail).includes("agreed discount"));
  // a new correction changes the amount -> the old resolution does not hide the new discrepancy
  await recordCodEntry({ orderId: o.id, adminId: "a1", kind: "ADJUSTMENT", amount: -100, note: "courier corrected its statement" });
  assert.ok((await codStateForOrder(o.id))?.openFlags.some((f) => f.code === "SHORT_COLLECTION" && f.amount === 770));
});

test("a WRITTEN-OFF shortfall can never be recorded as fully collected; an ACCEPTED difference can", async () => {
  const a = await deliveredByCourier(fakeProvider([OK("C-1")]));
  await recordCodEntry({ orderId: a.id, adminId: "a1", kind: "COLLECTION_REPORTED", amount: 3000 });
  await resolveCodDiscrepancy({ orderId: a.id, adminId: "a1", flagCode: "SHORT_COLLECTION", amount: 670, action: "WRITTEN_OFF", reason: "courier lost the cash, claim filed" });
  await assert.rejects(() => confirmCodCollection({ orderId: a.id, adminId: "a1", reason: "trying anyway to confirm" }), /written off/);
  assert.equal(balance(a.id).length, 0);
  assert.equal((await codStateForOrder(a.id))?.canConfirmCollection, false);

  const p = fakeProvider([OK("C-7")]);
  const b = await booked(p, 1, "ub");
  await hook(p, { consignment_id: "C-7", invoice: row(b.id).orderNumber, status: "delivered" });
  await recordCodEntry({ orderId: b.id, adminId: "a1", kind: "COLLECTION_REPORTED", amount: 1800 });
  await resolveCodDiscrepancy({ orderId: b.id, adminId: "a1", flagCode: "SHORT_COLLECTION", amount: 70, action: "ACCEPTED_DIFFERENCE", reason: "delivery charge waived by agreement" });
  await confirmCodCollection({ orderId: b.id, adminId: "a1", reason: "settled in full per agreement" });
  assert.equal(balance(b.id).length, 1);
});

test("the courier's own COD figure is compared with ours: a different amount is stored, warned about and flagged (booking echo and webhook)", async () => {
  const p = fakeProvider([{ ...OK(), codAmount: 100 }]);
  const o = await confirmedOrder();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(Number(row(o.id).courierCodAmount), 100);
  assert.match(String(row(o.id).courierLastError), /recorded a COD amount of 100/);
  const state = await codStateForOrder(o.id);
  assert.ok(state?.openFlags.some((f) => f.code === "BOOKED_AMOUNT_MISMATCH"));
  assert.equal((await listCourierAttention()).find((a) => a.id === o.id)?.reason, "cod_amount_mismatch");
  // a matching amount is no flag; the webhook can correct the stored figure
  const total = Number(row(o.id).total);
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "pending", cod_amount: total, updated_at: "2026-11-20T10:00:00Z" });
  assert.equal(Number(row(o.id).courierCodAmount), total);
  assert.ok(!(await codStateForOrder(o.id))?.openFlags.some((f) => f.code === "BOOKED_AMOUNT_MISMATCH"));
});

test("the reconciliation list exposes remittance status and supports the pending filter", async () => {
  const o = await deliveredByCourier();
  const all = await listCodReconciliation("ALL", 1, "ALL");
  assert.equal(all.rows.find((r) => r.id === o.id)?.remittance, "AWAITING_CONFIRMATION");
  assert.equal((await listCodReconciliation("ALL", 1, "PENDING")).rows.length, 1);
  assert.equal((await listCodReconciliation("ALL", 1, "SETTLED")).rows.length, 0);
  assert.equal(all.totals.pending, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Scheduled job
// ---------------------------------------------------------------------------------------------------------------------------------------

test("job: a stale BOOKING claim becomes UNCERTAIN (once, however often it runs) and is never re-booked automatically", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  db.patch("order", o.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: new Date(Date.now() - 3600_000), courierProvider: "steadfast" });
  const r1 = await reconcileCourier({ autoBook: true }, deps(p));
  const r2 = await reconcileCourier({ autoBook: true }, deps(p));
  assert.deepEqual([r1.staleRecovered, r2.staleRecovered], [1, 0]);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  assert.equal(p.bookCalls, 0);
  assert.ok(/never finished/.test(String(row(o.id).courierLastError)));
});

test("job: UNCERTAIN orders are checked with the courier when it can answer; a confirmed parcel is recorded, nothing is booked", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }], { lookup: true });
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  p.lookupAnswer = "found";
  const before = p.bookCalls;
  const r = await reconcileCourier({ autoBook: true }, deps(p));
  assert.deepEqual([r.uncertainChecked, r.remoteConfirmed], [1, 1]);
  assert.equal(p.bookCalls, before);
  const again = await reconcileCourier({ autoBook: true }, deps(p));
  assert.equal(again.uncertainChecked, 0); // already confirmed: not asked again
  // a courier without lookup leaves UNCERTAIN for an admin and is not an error
  const o2 = await confirmedOrder(1, "u2");
  const p2 = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }]);
  await bookOrderWithCourier(o2.id, { actor: TEST_ADMIN }, deps(p2));
  assert.equal((await reconcileCourier({}, deps(p2))).uncertainChecked, 0);
  assert.equal(row(o2.id).courierBookingStatus, "UNCERTAIN");
});

test("job: a just-booked order (still CONFIRMED) is polled; recently synced and finished consignments are not", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  p.statusToReturn = "pending";
  assert.equal((await reconcileCourier({}, deps(p))).polled, 1);
  assert.equal(p.statusCalls, 1);
  // synced a moment ago -> skipped by the next run
  assert.equal((await reconcileCourier({}, deps(p))).polled, 0);
  // an old sync is due again
  db.patch("order", o.id, { courierLastSyncAt: new Date(Date.now() - MIN_POLL_INTERVAL_MS - 1000) });
  assert.equal((await reconcileCourier({}, deps(p))).polled, 1);
  // a settled consignment is never polled again
  db.patch("order", o.id, { courierLastStatus: "cancelled", courierLastSyncAt: null });
  const calls = p.statusCalls;
  assert.equal((await reconcileCourier({}, deps(p))).polled, 0);
  assert.equal(p.statusCalls, calls);
});

test("job: an order another run is processing is skipped (lease), a crashed lease expires, and a failed poll backs off", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  db.patch("order", o.id, { courierSyncLeaseUntil: new Date(Date.now() + SYNC_LEASE_MS) });
  const busy = await reconcileCourier({}, deps(p));
  assert.deepEqual([busy.polled, busy.busySkipped, p.statusCalls], [0, 1, 0]);
  db.patch("order", o.id, { courierSyncLeaseUntil: new Date(Date.now() - 1000) }); // crashed run: expired
  p.fetchFails = true;
  const failed = await reconcileCourier({}, deps(p));
  assert.deepEqual([failed.polled, failed.pollFailed], [1, 1]);
  const backoff = row(o.id).courierSyncLeaseUntil as Date;
  assert.ok(backoff.getTime() > Date.now() + 10 * 60_000); // backing off
  assert.equal((await reconcileCourier({}, deps(p))).polled, 0); // not hammered
  // after the back-off the job recovers by itself
  db.patch("order", o.id, { courierSyncLeaseUntil: null });
  p.fetchFails = false; p.statusToReturn = "delivered";
  const ok = await reconcileCourier({}, deps(p));
  assert.deepEqual([ok.polled, ok.updated], [1, 1]);
  assert.equal(row(o.id).status, "DELIVERED");
  assert.equal(balance(o.id).length, 0);
});

test("job: concurrent runs never double-process or double-book", async () => {
  const p = fakeProvider();
  const a = await booked(p, 1, "ua");
  const b = await confirmedOrder(1, "ub");
  p.statusToReturn = "delivered";
  p.results = [OK("C-B")];
  const before = p.bookCalls;
  await Promise.all([1, 2, 3].map(() => reconcileCourier({ autoBook: true }, deps(p))));
  assert.equal(p.bookCalls - before, 1);
  assert.equal(row(a.id).status, "DELIVERED");
  assert.equal(db.rows("orderTrackingEvent").filter((e) => e.orderId === a.id && e.status === "DELIVERED").length, 1);
  assert.equal(row(b.id).courierBookingStatus, "BOOKED");
});

test("job: auto-booking still obeys every gate (advance, fraud) and never books an ineligible order", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { advanceRequired: 500, advancePaid: 0 });
  const p = fakeProvider();
  const r = await reconcileCourier({ autoBook: true }, deps(p));
  assert.deepEqual([p.bookCalls, r.autoBooked, r.autoBookSkipped], [0, 0, 1]);
  assert.equal(row(o.id).courierBookingStatus, "NOT_BOOKED");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Admin lists, diagnostics, customer visibility, regressions
// ---------------------------------------------------------------------------------------------------------------------------------------

test("shipment filters: not booked / booking / booked / failed / uncertain / delivered / delivery failed", async () => {
  const mk = async (u: string, patch: Record<string, unknown>) => { const o = await confirmedOrder(1, u); db.patch("order", o.id, patch); return o; };
  const nb = await mk("u1", {});
  const bk = await mk("u2", { courierBookingStatus: "BOOKING", courierBookingStartedAt: new Date() });
  const bd = await mk("u3", { courierBookingStatus: "BOOKED", courierConsignmentId: "X" });
  const fl = await mk("u4", { courierBookingStatus: "FAILED" });
  const un = await mk("u5", { courierBookingStatus: "UNCERTAIN" });
  const dl = await mk("u6", { courierBookingStatus: "BOOKED", status: "DELIVERED" });
  const df = await mk("u7", { courierBookingStatus: "MANUAL", status: "FAILED_DELIVERY" });
  const ids = async (f: Parameters<typeof listCourierShipments>[0]) => (await listCourierShipments(f)).rows.map((r) => r.id);
  assert.deepEqual(await ids("not_booked"), [nb.id]);
  assert.deepEqual(await ids("booking"), [bk.id]);
  assert.deepEqual(await ids("booked"), [bd.id]);
  assert.deepEqual(await ids("failed"), [fl.id]);
  assert.deepEqual(await ids("uncertain"), [un.id]);
  assert.deepEqual(await ids("delivered"), [dl.id]);
  assert.deepEqual(await ids("delivery_failed"), [df.id]);
  assert.deepEqual((await listCourierShipments("booked")).counts, { not_booked: 1, booking: 1, booked: 1, failed: 1, uncertain: 1, delivered: 1, delivery_failed: 1 });
});

test("diagnostics and connection test expose no secrets and require an authorised admin", async () => {
  const d = getCourierDiagnostics({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY-abcdef", COURIER_API_SECRET: "SEC-123456", COURIER_WEBHOOK_SECRET: "WH-secret-zzzz", CRON_SECRET: "c".repeat(30) });
  const dump = JSON.stringify(d);
  for (const s of ["KEY-abcdef", "SEC-123456", "WH-secret-zzzz", "c".repeat(30)]) assert.ok(!dump.includes(s));
  assert.equal(d.cronConfigured, true);
  assert.equal(d.providers.find((p) => p.key === "pathao")?.adapterAvailable, false); // no guessed adapter for undocumented couriers
  const longCfg = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY-abcdef", COURIER_API_SECRET: "SEC-123456" });
  const p = fakeProvider();
  p.checkConnection = async () => ({ ok: false, kind: "auth", message: "refused KEY-abcdef and SEC-123456" });
  const r = await testCourierConnection("steadfast", TEST_ADMIN, { provider: p, config: longCfg });
  assert.equal(r.ok, false);
  assert.ok(!r.message.includes("KEY-abcdef") && !r.message.includes("SEC-123456"));
  await assert.rejects(() => testCourierConnection("steadfast", { adminId: "nobody" }, { provider: p, config: longCfg }));
});

test("customers never see courier internals (event times, COD figure, confirmations, leases); notifications carry no internal data", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  db.patch("order", o.id, { courierCodAmount: 123, courierRemoteConfirmedAt: new Date(), courierSyncLeaseUntil: new Date(), courierEventAt: new Date(), courierLastSyncAt: new Date(), adminNote: "INTERNAL NOTE", riskScore: 88 });
  const view = await runAs({ sub: "cust" }, () => getOrderByNumberForCurrentUser(row(o.id).orderNumber)) as Record<string, unknown>;
  assert.ok(view);
  for (const k of ["courierCodAmount", "courierRemoteConfirmedAt", "courierSyncLeaseUntil", "courierEventAt", "courierLastSyncAt", "courierLastError", "courierConsignmentId", "adminNote", "riskScore"]) assert.ok(!(k in view), k);
  assert.equal(view.trackingNumber, "T-C-1");
  const notes = db.rows("notification").filter((n) => n.dedupeKey === `courier:${o.id}:booked`);
  assert.equal(notes.length, 1);
  const text = JSON.stringify(notes[0]);
  assert.ok(!/risk|fraud|INTERNAL|score|review/i.test(text));
  assert.match(String(notes[0].body), /T-C-1/);
});

test("P3/P3.1 regression: courier events create no ad-platform tracking events and do not re-trigger Purchase", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const before = JSON.stringify(db.rows("trackingEventLog").map((r) => [r.destination, r.eventName, r.orderId, r.status]));
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "delivered" });
  await refreshCourierStatus(o.id, TEST_ADMIN, deps(p)).catch(() => undefined);
  assert.equal(JSON.stringify(db.rows("trackingEventLog").map((r) => [r.destination, r.eventName, r.orderId, r.status])), before);
});

test("existing stock behaviour: booking, delivery and cancellation events never move stock", async () => {
  const p = fakeProvider();
  const o = await booked(p);
  const stock = db.get("product", "p-standard").stock;
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "delivered" });
  assert.equal(db.get("product", "p-standard").stock, stock);
  assert.ok(db.rows("orderItem").every((i) => i.orderId !== o.id || i.stockRestoredAt === null));
});

test("REGRESSION: a self-shipped marketplace order booked with its unpaid total is NOT flagged as a COD amount mismatch", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { paymentMethod: "MARKETPLACE", paymentStatus: "PENDING" });
  const total = Number(row(o.id).total);
  const p = fakeProvider([{ ...OK(), codAmount: total }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(p.requests[0].codAmount, total, "the booking asked the courier to collect the unpaid total");
  assert.equal((await listCourierAttention()).find((a) => a.id === o.id), undefined);
  // a genuinely different amount at the courier is still caught
  await hook(p, { consignment_id: "C-1", invoice: row(o.id).orderNumber, status: "pending", cod_amount: total - 10, updated_at: "2026-11-20T10:00:00Z" });
  assert.equal((await listCourierAttention()).find((a) => a.id === o.id)?.reason, "cod_amount_mismatch");
});
