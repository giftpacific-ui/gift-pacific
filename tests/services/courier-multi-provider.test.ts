/**
 * Admin courier management (multi-provider) against the REAL services (in-memory fake DB, MOCKED providers; nothing here calls a courier).
 * Groups: honest provider state, stored connection checks, isolation, booking outcomes on the timeline, stale / uncertain protection,
 * duplicate consignments, safe manual booking (including Pathao / RedX, which have no adapter), courier selection, and the panel data.
 * Every REGRESSION test names a defect that existed before this change.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, seedAdmins, TEST_ADMIN } from "../setup/helpers";
import { installDb, type FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import {
  bookOrderWithCourier, bulkBookOrders, getCourierPanel, getCourierProviderBoard, handleCourierWebhook, reconcileCourier,
  saveManualCourier, testAllCourierConnections, testCourierConnection,
} from "@/server/services/courier.service";
import { getCourierConfig } from "@/lib/courier/config";
import { credentialFingerprint } from "@/lib/courier/provider-state";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import { STALE_BOOKING_MS } from "@/lib/courier/status";
import type { CourierBookingResult, CourierConnectionResult, CourierProvider } from "@/lib/courier/types";
import { testAllCourierConnectionsAction } from "@/server/actions/admin-courier.actions";
import { updateOrderTrackingAction } from "@/server/actions/admin-order.actions";

let db: FakeDb;
const SECRET = "wh-secret-0123456789";
const KEY = "KEY-live-abcdef";
const SEC = "SEC-live-123456";
const ENV = { STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SEC, STEADFAST_WEBHOOK_SECRET: SECRET };
const config = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: KEY, COURIER_API_SECRET: SEC, COURIER_WEBHOOK_SECRET: SECRET });
const OK = (id = "C-1"): CourierBookingResult => ({ ok: true, consignmentId: id, trackingCode: `T-${id}`, trackingUrl: null, providerStatus: "in_review" });

type Fake = CourierProvider & { bookCalls: number; results: CourierBookingResult[]; check: () => Promise<CourierConnectionResult>; gate?: Promise<void> };
function fake(key = "steadfast", results: CourierBookingResult[] = [OK()]): Fake {
  const real = createSteadfastProvider(config, (async () => ({ kind: "network", message: "unused" })) as never);
  const p: Fake = {
    ...real, key, displayName: key === "steadfast" ? "Steadfast" : key, bookCalls: 0, results,
    check: async () => ({ ok: true }),
    async book() { p.bookCalls++; if (p.gate) await p.gate; return p.results[Math.min(p.bookCalls - 1, p.results.length - 1)]; },
    async checkConnection() { return p.check(); },
  };
  return p;
}
const deps = (p: CourierProvider, now?: () => Date) => ({ provider: p, config, now });

beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); db.patch("product", "p-standard", { stock: 500 }); });
const row = (id: string) => db.get("order", id);
const events = (id: string) => db.rows("courierShipmentEvent").filter((e) => e.orderId === id);
let seq = 0;
async function confirmedOrder() {
  const user = `cust-${++seq}`;
  await runAs({ sub: user }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const o = await runAs({ sub: user }, () => placeOrder(emptyCheckout));
  await adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN);
  return o;
}
const ago = (ms: number) => new Date(Date.now() - ms);
/**
 * Replaces ONE model delegate of the installed fake database (they are non-configurable getters, so plain assignment does nothing).
 * `make` receives the real delegate so a test can change a single method and keep the rest.
 */
function overrideModel(name: string, make: (real: Record<string, (a: never) => Promise<unknown>>) => Record<string, unknown>) {
  const real = db;
  const impl = make((real as unknown as Record<string, Record<string, (a: never) => Promise<unknown>>>)[name]);
  installDb(new Proxy(real, { get: (t, k) => (k === name ? impl : Reflect.get(t, k)) }));
}
const dump = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. Honest provider state + stored connection checks
// ---------------------------------------------------------------------------------------------------------------------------------------

test("board: Steadfast, Pathao and RedX are separate rows; credentials alone read CONFIGURED; Pathao / RedX are UNSUPPORTED even if their variables are set", async () => {
  const board = await getCourierProviderBoard({ env: { ...ENV, PATHAO_API_KEY: "p", REDX_API_KEY: "r", COURIER_DEFAULT_PROVIDER: "steadfast" } });
  assert.deepEqual(board.providers.map((p) => [p.key, p.state]), [["steadfast", "configured"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  const sf = board.providers[0];
  assert.equal(sf.reason, "never_checked");
  assert.equal(sf.isDefault, true);
  assert.equal(sf.canTest, true);
  assert.equal(sf.hasWebhookSecret, true);
  for (const p of board.providers.slice(1)) {
    assert.equal(p.adapterAvailable, false);
    assert.equal(p.canTest, false);
    assert.equal(p.choice.apiBookable, false);
    assert.match(p.detail, /no adapter/i);
  }
});

test("board: nothing configured -> Steadfast is DISCONNECTED (not configured), never connected", async () => {
  const board = await getCourierProviderBoard({ env: {} });
  assert.deepEqual([board.providers[0].state, board.providers[0].reason], ["disconnected", "not_configured"]);
  assert.equal(board.providers[0].canTest, false);
  assert.equal(board.defaultChoice.key, null);
});

test("board: switched off is DISCONNECTED with that reason, and cannot be tested or booked", async () => {
  const b = (await getCourierProviderBoard({ env: { ...ENV, STEADFAST_ENABLED: "false" } })).providers[0];
  assert.deepEqual([b.state, b.reason, b.canTest, b.choice.apiBookable], ["disconnected", "switched_off", false, false]);
});

test("REGRESSION: a successful real check is stored and only then reads CONNECTED; rotating a credential drops it back to CONFIGURED", async () => {
  const p = fake();
  const r = await testCourierConnection("steadfast", TEST_ADMIN, deps(p));
  assert.deepEqual([r.ok, r.checked], [true, true]);
  const stored = db.rows("courierConnectionCheck");
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].provider, stored[0].ok, stored[0].checkedById], ["steadfast", true, "a1"]);
  assert.equal(stored[0].fingerprint, credentialFingerprint(config));
  const connected = (await getCourierProviderBoard({ env: ENV })).providers[0];
  assert.deepEqual([connected.state, connected.reason], ["connected", "verified"]);
  assert.ok(connected.lastCheckedAt && connected.lastConnectedAt);
  const rotated = (await getCourierProviderBoard({ env: { ...ENV, STEADFAST_API_SECRET: "SEC-rotated-999999" } })).providers[0];
  assert.deepEqual([rotated.state, rotated.reason], ["configured", "credentials_changed"]);
  // and an old check is no evidence either
  const later = (await getCourierProviderBoard({ env: ENV, now: () => new Date(Date.now() + 7 * 3600_000) })).providers[0];
  assert.deepEqual([later.state, later.reason], ["configured", "check_stale"]);
});

test("a failed real check is stored (sanitised) and reads DISCONNECTED; the next success replaces it and keeps lastSuccessAt honest", async () => {
  const p = fake();
  p.check = async () => ({ ok: false, kind: "auth", message: `refused ${KEY} and ${SEC}` });
  const r = await testCourierConnection("steadfast", TEST_ADMIN, deps(p));
  assert.deepEqual([r.ok, r.checked], [false, true]);
  assert.ok(!r.message.includes(KEY) && !r.message.includes(SEC));
  const stored = db.rows("courierConnectionCheck")[0];
  assert.deepEqual([stored.ok, stored.failureKind, stored.lastSuccessAt], [false, "auth", null]);
  assert.ok(!dump(stored).includes(KEY) && !dump(stored).includes(SEC));
  assert.equal((await getCourierProviderBoard({ env: ENV })).providers[0].state, "disconnected");
  p.check = async () => ({ ok: true });
  await testCourierConnection("steadfast", TEST_ADMIN, deps(p));
  assert.equal(db.rows("courierConnectionCheck").length, 1, "one row per courier");
  assert.equal((await getCourierProviderBoard({ env: ENV })).providers[0].state, "connected");
});

test("REGRESSION: a courier that throws or hangs during a check is reported as a failed check, never as connected and never as a crash", async () => {
  const boom = fake();
  boom.check = async () => { throw new Error(`explode ${KEY}`); };
  const r1 = await testCourierConnection("steadfast", TEST_ADMIN, deps(boom));
  assert.deepEqual([r1.ok, r1.checked], [false, true]);
  assert.ok(!r1.message.includes("explode") && !r1.message.includes(KEY));
  assert.equal(db.rows("courierConnectionCheck")[0].failureKind, "unexpected");
  const hang = fake();
  hang.check = () => new Promise<CourierConnectionResult>(() => undefined);
  const r2 = await testCourierConnection("steadfast", TEST_ADMIN, { ...deps(hang), checkTimeoutMs: 25 });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /in time/);
  assert.equal(db.rows("courierConnectionCheck")[0].failureKind, "unreachable");
});

test("nothing is stored (and nothing is called) for a courier with no adapter or no credentials: an unproven courier cannot be 'checked'", async () => {
  for (const key of ["pathao", "redx"]) {
    const r = await testCourierConnection(key, TEST_ADMIN, { env: ENV });
    assert.deepEqual([r.ok, r.checked], [false, false], key);
    assert.match(r.message, /no API adapter/i);
  }
  const none = await testCourierConnection("steadfast", TEST_ADMIN, { env: {} });
  assert.deepEqual([none.ok, none.checked], [false, false]);
  const noCheck = fake();
  noCheck.checkConnection = undefined;
  assert.equal((await testCourierConnection("steadfast", TEST_ADMIN, deps(noCheck))).checked, false);
  // a provider answering for a DIFFERENT key must not be used for this one
  assert.equal((await testCourierConnection("pathao", TEST_ADMIN, deps(fake()))).checked, false);
  assert.equal(db.rows("courierConnectionCheck").length, 0);
});

test("board never throws when the evidence store is down: every courier simply reads as unproven", async () => {
  await testCourierConnection("steadfast", TEST_ADMIN, deps(fake())); // a real stored success exists...
  overrideModel("courierConnectionCheck", () => ({ findMany: async () => { throw new Error("db down"); } })); // ...but the store cannot be read
  const board = await getCourierProviderBoard({ env: ENV });
  assert.deepEqual(board.providers.map((p) => p.state), ["configured", "unsupported", "unsupported"]);
});

test("a failure to STORE a check does not hide its result from the admin (the state just stays unproven)", async () => {
  overrideModel("courierConnectionCheck", (real) => ({ ...real, upsert: async () => { throw new Error("db down"); } }));
  const r = await testCourierConnection("steadfast", TEST_ADMIN, deps(fake()));
  assert.deepEqual([r.ok, r.checked], [true, true]);
  assert.equal(db.rows("courierConnectionCheck").length, 0, "nothing stored");
  assert.equal((await getCourierProviderBoard({ env: ENV })).providers[0].state, "configured", "so it is NOT shown as connected");
});

test("ISOLATION: one courier's state failing to derive marks only THAT row; the others are unaffected", async () => {
  const hostile = new Proxy({ ...ENV } as Record<string, string | undefined>, {
    get(t, k) { if (k === "STEADFAST_API_KEY") throw new Error("env exploded"); return t[k as string]; },
  });
  const board = await getCourierProviderBoard({ env: hostile });
  const [sf, pathao, redx] = board.providers;
  assert.deepEqual([sf.state, sf.reason, sf.choice.apiBookable], ["disconnected", "error", false]);
  assert.match(sf.detail, /could not be determined/);
  assert.deepEqual([pathao.state, redx.state], ["unsupported", "unsupported"]);
});

test("testAll: one entry per courier; a failing / throwing Steadfast never affects Pathao and RedX (listed as unsupported, never called)", async () => {
  const p = fake();
  p.check = async () => { throw new Error("boom"); };
  const out = await testAllCourierConnections(TEST_ADMIN, deps(p));
  assert.deepEqual(out.map((e) => [e.key, e.outcome]), [["steadfast", "failed"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.ok(out.every((e) => !dump(e).includes("boom")));
  const ok = await testAllCourierConnections(TEST_ADMIN, deps(fake()));
  assert.deepEqual(ok.map((e) => e.outcome), ["connected", "unsupported", "unsupported"]);
  const none = await testAllCourierConnections(TEST_ADMIN, { env: {} });
  assert.deepEqual(none.map((e) => e.outcome), ["skipped", "unsupported", "unsupported"]);
});

test("testAll and tests require an authorised admin", async () => {
  await assert.rejects(testAllCourierConnections({ adminId: "nobody" }, deps(fake())), /not authorised/i);
  await assert.rejects(testCourierConnection("steadfast", { adminId: null }, deps(fake())), /not authorised/i);
  assert.equal(db.rows("courierConnectionCheck").length, 0);
  const viaAction = await runAs("admin", () => testAllCourierConnectionsAction());
  assert.equal(viaAction.success, true);
});

test("the board exposes no credential, webhook secret or credential fingerprint", async () => {
  await testCourierConnection("steadfast", TEST_ADMIN, deps(fake()));
  const text = dump(await getCourierProviderBoard({ env: ENV }));
  for (const s of [KEY, SEC, SECRET, credentialFingerprint(config)]) assert.ok(!text.includes(s), s);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. Booking outcomes land on the timeline
// ---------------------------------------------------------------------------------------------------------------------------------------

test("REGRESSION: a rejected booking is on the timeline (it used to leave no trace except lastError)", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [{ ok: false, kind: "rejected", message: `invalid phone ${KEY}` }]);
  const r = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(r.booked, false);
  assert.equal(row(o.id).courierBookingStatus, "FAILED");
  const [e] = events(o.id);
  assert.deepEqual([e.source, e.rawStatus, e.provider, e.outcome], ["BOOKING_FAILED", "rejected", "steadfast", "RECORDED"]);
  assert.match(e.note, /invalid phone/);
  assert.ok(!e.note.includes(KEY), "provider text is sanitised before it is stored");
  const panel = await getCourierPanel(o.id, deps(p));
  assert.equal(panel!.timeline[0].title, "Steadfast rejected the booking");
  assert.equal(panel!.timeline[0].tone, "error");
});

test("REGRESSION: an uncertain booking (timeout, 5xx, a throwing adapter) is on the timeline as unconfirmed", async () => {
  const a = await confirmedOrder();
  await bookOrderWithCourier(a.id, { actor: TEST_ADMIN }, deps(fake("steadfast", [{ ok: false, kind: "uncertain", message: "no answer" }])));
  assert.equal(events(a.id)[0].source, "BOOKING_UNCERTAIN");
  const b = await confirmedOrder();
  const thrower = fake();
  thrower.book = async () => { throw new Error("boom"); };
  await bookOrderWithCourier(b.id, { actor: TEST_ADMIN }, deps(thrower));
  assert.equal(events(b.id)[0].source, "BOOKING_UNCERTAIN");
  assert.equal(row(b.id).courierBookingStatus, "UNCERTAIN");
  const panel = await getCourierPanel(a.id, deps(fake()));
  assert.equal(panel!.timeline[0].title, "Booking with Steadfast is unconfirmed");
  assert.equal(panel!.timeline[0].tone, "warn");
});

test("a successful booking is on the timeline with its consignment, newest entries first", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [{ ok: false, kind: "rejected", message: "bad address" }, OK("C-77")]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p, () => new Date(Date.now() - 5000)));
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  const panel = await getCourierPanel(o.id, deps(p));
  assert.deepEqual(panel!.timeline.map((t) => t.title), ["Booked with Steadfast", "Steadfast rejected the booking"].map((x) => x));
  assert.equal(panel!.timeline[0].detail, "Consignment C-77");
  assert.equal(panel!.consignmentId, "C-77");
  assert.equal(panel!.bookingStatus, "BOOKED");
});

test("REGRESSION: a REJECTED retry of an unconfirmed booking keeps the order UNCERTAIN (it used to become FAILED = one-click retry, or another courier)", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [{ ok: false, kind: "uncertain", message: "timeout" }, { ok: false, kind: "rejected", message: "invoice already taken" }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  const r = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, deps(p));
  assert.equal(r.booked, false);
  assert.match((r as { message: string }).message, /earlier attempt may still have created a parcel/i);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  assert.equal(events(o.id).filter((e) => e.source === "BOOKING_FAILED").length, 1);
  assert.match(events(o.id).find((e) => e.source === "BOOKING_FAILED")!.note, /stays unconfirmed/);
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /confirm to retry|check the courier portal/i);
  assert.equal(p.bookCalls, 2);
});

test("a first-time definite rejection is still FAILED (and a later success records that it was a retry-free booking)", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [{ ok: false, kind: "rejected", message: "no" }, OK()]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(row(o.id).courierBookingStatus, "FAILED");
  assert.equal((await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p))).booked, true);
  assert.equal(events(o.id).find((e) => e.source === "BOOKING")!.note, null);
});

test("an uncertain order that is later booked on a confirmed retry says so on the timeline", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [{ ok: false, kind: "uncertain", message: "t" }, OK("C-2")]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, deps(p));
  assert.match(events(o.id).find((e) => e.source === "BOOKING")!.note, /retry of an earlier unconfirmed attempt/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. Stale BOOKING protection
// ---------------------------------------------------------------------------------------------------------------------------------------

test("a FRESH booking claim is 'in progress'; a STALE one needs the admin's confirmation (and the panel says it is stale)", async () => {
  const o = await confirmedOrder();
  const p = fake();
  db.patch("order", o.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(60_000), courierProvider: "steadfast" });
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /already in progress/);
  assert.equal((await getCourierPanel(o.id, deps(p)))!.staleBooking, false);
  db.patch("order", o.id, { courierBookingStartedAt: ago(STALE_BOOKING_MS + 1000) });
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /never finished|confirm to retry/i);
  assert.equal(p.bookCalls, 0);
  const panel = await getCourierPanel(o.id, deps(p));
  assert.deepEqual([panel!.staleBooking, panel!.needsConfirmation, panel!.canBook], [true, true, true]);
  assert.equal((await bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, deps(p))).booked, true);
});

test("REGRESSION: a stale BOOKING claim made with courier A can no longer be re-booked with courier B (only UNCERTAIN was guarded)", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(STALE_BOOKING_MS + 1000), courierProvider: "steadfast" });
  const other = fake("other");
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true, provider: "other" }, { byKey: { other: { config, provider: other } } }), /still unconfirmed.*Settle it with Steadfast/);
  assert.equal(other.bookCalls, 0);
  assert.equal(row(o.id).courierBookingStatus, "BOOKING");
  // the same rule for UNCERTAIN
  db.patch("order", o.id, { courierBookingStatus: "UNCERTAIN", courierBookingStartedAt: null });
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true, provider: "other" }, { byKey: { other: { config, provider: other } } }), /Settle it with Steadfast/);
  assert.equal(other.bookCalls, 0);
});

test("REGRESSION: the scheduled pass converts each stale claim to UNCERTAIN and puts it on the timeline (fresh claims are left alone)", async () => {
  const stale = await confirmedOrder();
  const fresh = await confirmedOrder();
  db.patch("order", stale.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(STALE_BOOKING_MS + 5000), courierProvider: "steadfast" });
  db.patch("order", fresh.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(30_000), courierProvider: "steadfast" });
  const out = await reconcileCourier({}, deps(fake()));
  assert.equal(out.staleRecovered, 1);
  assert.equal(row(stale.id).courierBookingStatus, "UNCERTAIN");
  assert.equal(row(fresh.id).courierBookingStatus, "BOOKING");
  assert.deepEqual(events(stale.id).map((e) => e.source), ["BOOKING_UNCERTAIN"]);
  assert.equal(events(fresh.id).length, 0);
  assert.equal((await reconcileCourier({}, deps(fake()))).staleRecovered, 0, "running it again converts nothing twice");
  assert.equal(events(stale.id).length, 1);
});

test("REGRESSION: a booking whose claim was converted to UNCERTAIN while the courier call was in flight still keeps the consignment (it used to be lost)", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [OK("C-LATE")]);
  let release!: () => void;
  p.gate = new Promise<void>((r) => (release = r));
  const slow = bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p, () => new Date(Date.now() - 3 * STALE_BOOKING_MS)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(row(o.id).courierBookingStatus, "BOOKING");
  await reconcileCourier({}, deps(fake())); // the claim looks stale to the scheduled pass
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  release();
  assert.deepEqual(await slow, { booked: true, consignmentId: "C-LATE" });
  assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).courierConsignmentId], ["BOOKED", "C-LATE"]);
});

test("if the order changed under a booking (hand entry won the race), the courier's consignment is reported and logged, never silently dropped or overwritten", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [OK("C-ORPHAN")]);
  let release!: () => void;
  p.gate = new Promise<void>((r) => (release = r));
  const slow = bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  await new Promise((r) => setTimeout(r, 20));
  db.patch("order", o.id, { courierBookingStatus: "MANUAL", courierName: "Rider", trackingNumber: "R-1" });
  release();
  const r = await slow;
  assert.equal(r.booked, false);
  assert.match((r as { message: string }).message, /C-ORPHAN.*Enter that consignment by hand/);
  assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).trackingNumber, row(o.id).courierConsignmentId ?? null], ["MANUAL", "R-1", null]);
  const e = events(o.id).find((x) => x.source === "BOOKING_UNCERTAIN")!;
  assert.equal(e.consignmentId, "C-ORPHAN");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 4. Duplicate consignment prevention
// ---------------------------------------------------------------------------------------------------------------------------------------

test("REGRESSION: a courier answering with a consignment another order already holds never produces a second BOOKED order; it is UNCERTAIN", async () => {
  const a = await confirmedOrder();
  const b = await confirmedOrder();
  const p = fake("steadfast", [OK("C-SAME")]);
  await bookOrderWithCourier(a.id, { actor: TEST_ADMIN }, deps(p));
  const r = await bookOrderWithCourier(b.id, { actor: TEST_ADMIN }, deps(p));
  assert.equal(r.booked, false);
  assert.match((r as { message: string }).message, new RegExp(`${a.orderNumber} already holds`));
  assert.equal(row(b.id).courierBookingStatus, "UNCERTAIN");
  assert.equal(row(b.id).courierConsignmentId ?? null, null);
  assert.deepEqual([row(a.id).courierBookingStatus, row(a.id).courierConsignmentId], ["BOOKED", "C-SAME"]);
  assert.equal(events(b.id)[0].source, "BOOKING_UNCERTAIN");
});

test("the database's unique index is the last line of defence: a race it catches ends UNCERTAIN, not as an error and not as BOOKED", async () => {
  const o = await confirmedOrder();
  overrideModel("order", (real) => ({
    ...real,
    updateMany: async (a: { data: Record<string, unknown> }) => {
      if (a.data.courierBookingStatus === "BOOKED") throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      return real.updateMany(a as never);
    },
  }));
  const r = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(fake("steadfast", [OK("C-RACE")])));
  assert.equal(r.booked, false);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  assert.equal(row(o.id).courierConsignmentId ?? null, null);
});

test("the fake database enforces the same unique rule as the migration (a pair can repeat only while a part is NULL)", () => {
  db.insert("order", { id: "x1", orderNumber: "X1", courierProvider: "steadfast", courierConsignmentId: "C-1" });
  db.insert("order", { id: "x2", orderNumber: "X2", courierProvider: "pathao", courierConsignmentId: "C-1" });
  db.insert("order", { id: "x3", orderNumber: "X3", courierProvider: null, courierConsignmentId: null });
  db.insert("order", { id: "x4", orderNumber: "X4", courierProvider: null, courierConsignmentId: null });
  assert.throws(() => db.insert("order", { id: "x5", orderNumber: "X5", courierProvider: "steadfast", courierConsignmentId: "C-1" }), /Unique constraint/);
});

test("webhook adoption of a lost booking: the consignment is adopted once, logged as a booking, and only by an order of THAT courier", async () => {
  const p = fake();
  const hook = (body: object) => handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify(body) }, deps(p));
  const mine = await confirmedOrder();
  const theirs = await confirmedOrder();
  db.patch("order", mine.id, { courierBookingStatus: "UNCERTAIN", courierProvider: "steadfast" });
  db.patch("order", theirs.id, { courierBookingStatus: "UNCERTAIN", courierProvider: "other-courier" });
  const none = await hook({ consignment_id: "C-9", invoice: theirs.orderNumber, status: "in_review" });
  assert.equal(none.body.note, "unknown consignment");
  assert.equal(row(theirs.id).courierBookingStatus, "UNCERTAIN");
  const ok = await hook({ consignment_id: "C-8", invoice: mine.orderNumber, status: "in_review" });
  assert.equal(ok.status, 200);
  assert.deepEqual([row(mine.id).courierBookingStatus, row(mine.id).courierConsignmentId], ["BOOKED", "C-8"]);
  const adopted = events(mine.id).find((e) => e.source === "BOOKING")!;
  assert.deepEqual([adopted.rawStatus, adopted.consignmentId], ["adopted", "C-8"]);
  // the same consignment can never be adopted by a second order
  const again = await hook({ consignment_id: "C-8", invoice: theirs.orderNumber, status: "in_review" });
  assert.equal(again.body.note, "mismatch");
  assert.equal(row(theirs.id).courierBookingStatus, "UNCERTAIN");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 5. Safe manual booking
// ---------------------------------------------------------------------------------------------------------------------------------------

test("manual booking works for a courier WITHOUT an adapter (Pathao): provider, name, consignment and tracking are stored and logged; API booking is then blocked", async () => {
  const o = await confirmedOrder();
  await saveManualCourier(o.id, { provider: "pathao", consignmentId: "DP-1234", trackingNumber: "TRK-1" }, TEST_ADMIN);
  const r = row(o.id);
  assert.deepEqual([r.courierBookingStatus, r.courierProvider, r.courierName, r.courierConsignmentId, r.trackingNumber], ["MANUAL", "pathao", "Pathao", "DP-1234", "TRK-1"]);
  const e = events(o.id)[0];
  assert.deepEqual([e.source, e.provider, e.rawStatus, e.consignmentId], ["MANUAL", "pathao", "manual_entered", "DP-1234"]);
  assert.match(e.note, /consignment DP-1234/);
  const p = fake();
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p)), /entered manually/);
  assert.equal(p.bookCalls, 0);
  const panel = await getCourierPanel(o.id, { env: ENV });
  assert.deepEqual([panel!.orderProvider, panel!.consignmentId, panel!.canRefresh, panel!.canRecover], ["pathao", "DP-1234", false, false]);
  assert.equal(panel!.timeline[0].title, "Courier details entered by hand (Pathao)");
});

test("manual entry with no courier at all still works (a local rider), with the typed name", async () => {
  const o = await confirmedOrder();
  await saveManualCourier(o.id, { courierName: "Local Rider", trackingNumber: "L-1" }, TEST_ADMIN);
  assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).courierName, row(o.id).courierProvider ?? null], ["MANUAL", "Local Rider", null]);
  assert.equal(events(o.id)[0].provider, "manual");
});

test("manual entry validates the courier key, the consignment id and the link before anything is written", async () => {
  const o = await confirmedOrder();
  const bad = (d: Parameters<typeof saveManualCourier>[1], re: RegExp) => assert.rejects(saveManualCourier(o.id, d, TEST_ADMIN), re);
  await bad({ provider: "fedex", courierName: "x" }, /listed couriers/);
  await bad({ consignmentId: "C-1" }, /Choose the courier/);
  await bad({ provider: "pathao", consignmentId: "a b" }, /consignment ID may contain only/);
  await bad({ provider: "pathao", consignmentId: "x".repeat(65) }, /consignment ID may contain only/);
  await bad({ provider: "pathao", consignmentId: "../etc" }, /consignment ID may contain only/);
  await bad({ courierName: "R", trackingUrl: "javascript:alert(1)" }, /http/);
  assert.equal(row(o.id).courierBookingStatus, "NOT_BOOKED");
  assert.equal(events(o.id).length, 0);
  await assert.rejects(saveManualCourier("missing", { courierName: "x" }, TEST_ADMIN), /not found/i);
});

test("REGRESSION: one consignment belongs to one order: a hand entry that reuses it is refused (same courier only; another courier may reuse the number)", async () => {
  const a = await confirmedOrder();
  const b = await confirmedOrder();
  await saveManualCourier(a.id, { provider: "pathao", consignmentId: "DP-1" }, TEST_ADMIN);
  await assert.rejects(saveManualCourier(b.id, { provider: "pathao", consignmentId: "DP-1" }, TEST_ADMIN), new RegExp(`already recorded on order ${a.orderNumber}`));
  assert.equal(row(b.id).courierBookingStatus, "NOT_BOOKED");
  await saveManualCourier(b.id, { provider: "redx", consignmentId: "DP-1" }, TEST_ADMIN);
  await saveManualCourier(a.id, { provider: "pathao", consignmentId: "DP-1", trackingNumber: "T" }, TEST_ADMIN); // re-saving its own is fine
  // and the unique index catching a race is a clear message, not a crash
  const c = await confirmedOrder();
  overrideModel("order", (real) => ({ ...real, updateMany: async () => { throw Object.assign(new Error("Unique"), { code: "P2002" }); } }));
  await assert.rejects(saveManualCourier(c.id, { provider: "pathao", consignmentId: "DP-9" }, TEST_ADMIN), /already recorded on another order/);
});

test("REGRESSION: saving EMPTY details never erases an unconfirmed or failed booking (it used to reset UNCERTAIN to NOT_BOOKED = a blind second booking)", async () => {
  const o = await confirmedOrder();
  for (const status of ["UNCERTAIN", "FAILED"]) {
    db.patch("order", o.id, { courierBookingStatus: status, courierLastError: "keep me" });
    await assert.rejects(saveManualCourier(o.id, {}, TEST_ADMIN), /cannot be cleared by saving empty details/);
    await assert.rejects(saveManualCourier(o.id, { courierName: "   " }, TEST_ADMIN), /cannot be cleared/);
    assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).courierLastError], [status, "keep me"]);
  }
  // through the admin action too
  db.patch("order", o.id, { courierBookingStatus: "UNCERTAIN" });
  const res = await runAs("admin", () => updateOrderTrackingAction(o.id, { courierName: "", trackingNumber: "", trackingUrl: "" }));
  assert.equal(res.success, false);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  // a stale claim is protected the same way; a never-booked order is a harmless no-op
  db.patch("order", o.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(STALE_BOOKING_MS + 1000) });
  await assert.rejects(saveManualCourier(o.id, {}, TEST_ADMIN), /cannot be cleared/);
  db.patch("order", o.id, { courierBookingStatus: "NOT_BOOKED", courierBookingStartedAt: null });
  await saveManualCourier(o.id, {}, TEST_ADMIN);
  assert.equal(row(o.id).courierBookingStatus, "NOT_BOOKED");
  assert.equal(events(o.id).length, 0);
});

test("REGRESSION: clearing a hand entry that was made over an unsettled attempt returns to UNCONFIRMED, not 'not booked'", async () => {
  const o = await confirmedOrder();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(fake("steadfast", [{ ok: false, kind: "uncertain", message: "timeout" }])));
  await saveManualCourier(o.id, { courierName: "Rider", trackingNumber: "R-1" }, TEST_ADMIN);
  assert.equal(row(o.id).courierBookingStatus, "MANUAL");
  assert.match(events(o.id).find((e) => e.source === "MANUAL")!.note, /replaced an unconfirmed booking attempt/);
  await saveManualCourier(o.id, {}, TEST_ADMIN);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  assert.deepEqual([row(o.id).courierName ?? null, row(o.id).trackingNumber ?? null, row(o.id).courierConsignmentId ?? null], [null, null, null]);
  assert.match(row(o.id).courierLastError, /never settled/);
  assert.equal(events(o.id).at(-1)!.rawStatus, "manual_cleared");
  // and it is still protected from a blind retry
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(fake())), /confirm to retry|check the courier portal/i);
});

test("clearing a hand entry on an order that never had a booking attempt returns to NOT_BOOKED (existing behaviour) and is logged", async () => {
  const o = await confirmedOrder();
  await saveManualCourier(o.id, { provider: "redx", trackingNumber: "RX-1" }, TEST_ADMIN);
  await saveManualCourier(o.id, {}, TEST_ADMIN);
  assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).courierProvider ?? null], ["NOT_BOOKED", null]);
  assert.deepEqual(events(o.id).map((e) => e.rawStatus), ["manual_entered", "manual_cleared"]);
  assert.equal((await getCourierPanel(o.id, { env: ENV }))!.timeline[0].title, "Hand-entered courier details cleared");
});

test("an unconfirmed booking CAN be settled by hand once the admin has checked the portal; a booked or fresh-in-flight one cannot", async () => {
  const o = await confirmedOrder();
  db.patch("order", o.id, { courierBookingStatus: "UNCERTAIN", courierRemoteConfirmedAt: new Date(), courierProvider: "steadfast" });
  await saveManualCourier(o.id, { provider: "steadfast", consignmentId: "C-HAND", trackingNumber: "T" }, TEST_ADMIN);
  assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).courierRemoteConfirmedAt, row(o.id).courierConsignmentId], ["MANUAL", null, "C-HAND"]);
  const stale = await confirmedOrder();
  db.patch("order", stale.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(STALE_BOOKING_MS + 1000), courierProvider: "steadfast" });
  await saveManualCourier(stale.id, { courierName: "Rider" }, TEST_ADMIN);
  assert.deepEqual([row(stale.id).courierBookingStatus, row(stale.id).courierBookingStartedAt], ["MANUAL", null]);
  const fresh = await confirmedOrder();
  db.patch("order", fresh.id, { courierBookingStatus: "BOOKING", courierBookingStartedAt: ago(10_000) });
  await assert.rejects(saveManualCourier(fresh.id, { courierName: "Rider" }, TEST_ADMIN), /courier API/);
  const done = await confirmedOrder();
  await bookOrderWithCourier(done.id, { actor: TEST_ADMIN }, deps(fake("steadfast", [OK("C-B")])));
  await assert.rejects(saveManualCourier(done.id, { courierName: "Overwrite" }, TEST_ADMIN), /courier API/);
  assert.equal(row(done.id).courierConsignmentId, "C-B");
});

test("the admin action passes provider and consignment through, ignores non-string junk, and reports refusals as messages", async () => {
  const o = await confirmedOrder();
  const ok = await runAs("admin", () => updateOrderTrackingAction(o.id, { provider: "pathao", consignmentId: "DP-5", courierName: "" }));
  assert.equal(ok.success, true);
  assert.deepEqual([row(o.id).courierProvider, row(o.id).courierConsignmentId], ["pathao", "DP-5"]);
  const junk = await confirmedOrder();
  const res = await runAs("admin", () => updateOrderTrackingAction(junk.id, { provider: { $ne: 1 } as never, consignmentId: 5 as never, courierName: "Rider" }));
  assert.equal(res.success, true);
  assert.equal(row(junk.id).courierProvider ?? null, null);
  assert.equal(row(junk.id).courierConsignmentId ?? null, null);
  const dup = await confirmedOrder();
  const refused = await runAs("admin", () => updateOrderTrackingAction(dup.id, { provider: "pathao", consignmentId: "DP-5" }));
  assert.deepEqual([refused.success, (refused as { message?: string }).message?.includes("already recorded")], [false, true]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 6. Courier selection, automatic default, unsupported couriers
// ---------------------------------------------------------------------------------------------------------------------------------------

test("choosing Pathao or RedX for an API booking is refused with 'record by hand' BEFORE anything is claimed or sent", async () => {
  const o = await confirmedOrder();
  for (const key of ["pathao", "redx"]) {
    await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN, provider: key }, { env: ENV }), /no API adapter.*Record the booking by hand/i);
  }
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN, provider: "fedex" }, { env: ENV }), /not an available courier/);
  assert.deepEqual([row(o.id).courierBookingStatus, row(o.id).courierProvider ?? null], ["NOT_BOOKED", null]);
  assert.equal(events(o.id).length, 0);
});

test("automatic selection never falls back to another courier: a default that names Pathao (no adapter) refuses to book instead of using Steadfast", async () => {
  const o = await confirmedOrder();
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { env: { ...ENV, COURIER_DEFAULT_PROVIDER: "pathao" } }), /Unsupported COURIER_PROVIDER "pathao"/);
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { env: {} }), /No courier provider is configured/);
  assert.equal(row(o.id).courierBookingStatus, "NOT_BOOKED");
});

test("bulk booking with an unsupported courier skips every order without touching it; other orders' results stay independent", async () => {
  const a = await confirmedOrder();
  const b = await confirmedOrder();
  const res = await bulkBookOrders([a.id, b.id], { env: ENV }, { actor: TEST_ADMIN, provider: "pathao" });
  assert.deepEqual(res.map((r) => r.status), ["skipped", "skipped"]);
  assert.ok(res.every((r) => /no API adapter/i.test(r.message)));
  assert.deepEqual([row(a.id).courierBookingStatus, row(b.id).courierBookingStatus], ["NOT_BOOKED", "NOT_BOOKED"]);
});

test("a failure at one courier cannot prevent the board, the panel or a hand entry: Steadfast down still lets Pathao be recorded by hand", async () => {
  const o = await confirmedOrder();
  const down = fake();
  down.book = async () => { throw new Error("down"); };
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(down));
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  const board = await getCourierProviderBoard({ env: ENV });
  assert.equal(board.providers.length, 3);
  const panel = await getCourierPanel(o.id, { env: ENV });
  assert.equal(panel!.choices.length, 3);
  await saveManualCourier(o.id, { provider: "pathao", consignmentId: "DP-7" }, TEST_ADMIN);
  assert.equal(row(o.id).courierProvider, "pathao");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 7. Panel data (what the admin screen shows)
// ---------------------------------------------------------------------------------------------------------------------------------------

test("panel: all three couriers are offered with honest states; Pathao / RedX can never be selected for an API booking; Automatic names the real default", async () => {
  const o = await confirmedOrder();
  await testCourierConnection("steadfast", TEST_ADMIN, deps(fake()));
  const panel = await getCourierPanel(o.id, { env: ENV });
  assert.deepEqual(panel!.choices.map((c) => [c.key, c.state, c.apiBookable]), [["steadfast", "connected", true], ["pathao", "unsupported", false], ["redx", "unsupported", false]]);
  assert.match(panel!.choices[1].optionText, /Unsupported \(no API adapter: record by hand\)/);
  assert.deepEqual([panel!.automatic.key, panel!.defaultProvider], ["steadfast", "steadfast"]);
  assert.match(panel!.automatic.message, /only configured courier/);
});

test("panel: with nothing configured every courier is unavailable, booking is not offered, and the reason is shown (manual entry stays possible)", async () => {
  const o = await confirmedOrder();
  const panel = await getCourierPanel(o.id, { env: {} });
  assert.equal(panel!.choices.some((c) => c.apiBookable), false);
  assert.equal(panel!.automatic.key, null);
  assert.equal(panel!.canBook, false);
  assert.ok(panel!.providerProblem);
  await saveManualCourier(o.id, { provider: "redx", trackingNumber: "RX-9" }, TEST_ADMIN);
  assert.equal((await getCourierPanel(o.id, { env: {} }))!.orderProvider, "redx");
});

test("panel shows consignment id and booking status, and exposes no credential or fingerprint", async () => {
  const o = await confirmedOrder();
  const p = fake("steadfast", [OK("C-55")]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(p));
  await testCourierConnection("steadfast", TEST_ADMIN, deps(p));
  const panel = await getCourierPanel(o.id, { ...deps(p), env: ENV });
  assert.deepEqual([panel!.bookingStatus, panel!.consignmentId, panel!.orderProvider, panel!.courierName], ["BOOKED", "C-55", "steadfast", "Steadfast"]);
  assert.equal(panel!.canBook, false);
  const text = dump(panel);
  for (const s of [KEY, SEC, SECRET, credentialFingerprint(config)]) assert.ok(!text.includes(s), s);
});

test("panel timeline shows the full story in order: rejected, unconfirmed, hand-entered, then courier statuses", async () => {
  const o = await confirmedOrder();
  const t = (ms: number) => () => new Date(Date.now() - ms);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(fake("steadfast", [{ ok: false, kind: "rejected", message: "bad" }]), t(4000)));
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, deps(fake("steadfast", [{ ok: false, kind: "uncertain", message: "slow" }]), t(3000)));
  await saveManualCourier(o.id, { provider: "steadfast", consignmentId: "C-M" }, TEST_ADMIN);
  const titles = (await getCourierPanel(o.id, { env: ENV }))!.timeline.map((e) => e.title);
  assert.equal(titles[0], "Courier details entered by hand (Steadfast)");
  assert.ok(titles.includes("Steadfast rejected the booking") && titles.includes("Booking with Steadfast is unconfirmed"));
  assert.equal(titles.length, 3);
});
