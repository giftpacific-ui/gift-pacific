/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, drainAfter, emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { prisma } from "@/lib/db/prisma";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import {
  deliverTrackingEvent, enqueuePurchaseEvent, isGa4ServerPurchaseActive, retryTrackingEvent, runTrackingMaintenance,
} from "@/server/services/tracking-event.service";
import { withdrawTrackingConsent } from "@/server/services/consent-withdrawal.service";
import { snapshotOrderAttribution } from "@/server/services/order-attribution.service";
import { purchaseEvent } from "@/lib/analytics/payloads";
import { purchaseEventId } from "@/lib/analytics/ids";

const META_TOKEN = "EAAGsecrettokenvalue1234567890";
const GA4_SECRET = "ga4-api-secret-VALUE-1234567890";
const REF_A = "A".repeat(22);
const REF_B = "B".repeat(22);
const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
let db: FakeDb;
type Call = { url: string; body: any };
let calls: Call[];
let metaRespond: () => Response | Promise<Response>;
let ga4Respond: () => Response | Promise<Response>;
const metaOk = () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: "TRACE" }), { status: 200 });
const ga4Ok = () => new Response(null, { status: 204 });
const status = (code: number, body: unknown = {}) => () => new Response(JSON.stringify(body), { status: code });
const meta = () => calls.filter((c) => c.url.includes("graph.facebook.com"));
const ga4 = () => calls.filter((c) => c.url.includes("google-analytics.com"));

beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("storeSettings", "singleton", { metaPixelId: "123456789", gtmId: "G-ABCD1234", consentMode: "OFF" });
  process.env.META_CONVERSIONS_API_TOKEN = META_TOKEN;
  process.env.GA4_API_SECRET = GA4_SECRET;
  process.env.CRON_SECRET = "c".repeat(32);
  delete process.env.GA4_MP_DEBUG; delete process.env.GA4_MEASUREMENT_ID; delete process.env.META_CAPI_TEST_EVENT_CODE;
  (globalThis as any).__TEST_COOKIES__.clear();
  (globalThis as any).__TEST_HEADERS__ = {};
  calls = []; metaRespond = metaOk; ga4Respond = ga4Ok; discardAfter();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return String(url).includes("google-analytics.com") ? ga4Respond() : metaRespond();
  }) as never;
});
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...realEnv }; discardAfter(); });

const logs = () => db.rows("trackingEventLog");
const logOf = (orderId: string, destination: string) => logs().find((l) => l.orderId === orderId && l.destination === destination)!;
const orderOf = async (productId = "p-standard", quantity = 1) => {
  await runAs({ sub: "cust" }, () => addItemToCart({ productId, variantId: null, quantity }));
  return runAs({ sub: "cust" }, () => placeOrder(emptyCheckout));
};
/** Confirms WITHOUT running the scheduled background delivery (what the admin's request itself does). */
const confirmOnly = (id: string) => adminUpdateOrderStatus(id, "CONFIRMED" as never, undefined, TEST_ADMIN);
const confirm = async (id: string) => { const r = await confirmOnly(id); await drainAfter(); return r; };
const move = async (id: string, to: string) => { const r = await adminUpdateOrderStatus(id, to as never, undefined, TEST_ADMIN); await drainAfter(); return r; };
const attribution = (orderId: string, over: Record<string, unknown> = {}) =>
  db.insert("orderAttribution", {
    id: `attr-${orderId}`, orderId, userId: "cust", consentState: "GRANTED", consentRef: REF_A, consentWithdrawnAt: null, firstTouch: { at: 1, source: "fb" }, lastTouch: { at: 2, source: "fb" },
    fbc: null, fbp: "fb.1.1700000000000.1234567890", clientIp: "203.0.113.7", clientUserAgent: "Mozilla/5.0",
    gaClientId: "1234567890.1700000000", gaSessionId: "1700000000", contactScrubbedAt: null, createdAt: new Date(), ...over,
  });

// ================================================================================================ background-first delivery

test("confirming an order only PERSISTS the events: no request to Meta or Google is made (or waited for) during the confirmation", async () => {
  const o = await orderOf(); attribution(o.id);
  await confirmOnly(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
  assert.equal(calls.length, 0, "nothing was sent while the admin's request ran");
  assert.deepEqual(logs().map((l) => [l.destination, l.status]).sort(), [["GA4_MP", "PENDING"], ["META_CAPI", "PENDING"]]);
  assert.equal(((globalThis as any).__TEST_AFTER__ as unknown[]).length, 1, "one best-effort delivery kick is scheduled");
  await drainAfter(); // the platform runs it after the response
  assert.equal(meta().length, 1);
  assert.equal(ga4().length, 1);
  assert.ok(logs().every((l) => l.status === "SENT"));
});

test("an unreachable / hanging Meta or Google can NEVER delay or fail the admin's confirmation", async () => {
  const o = await orderOf(); attribution(o.id);
  globalThis.fetch = (() => new Promise(() => undefined)) as never; // never answers
  const started = Date.now();
  await confirmOnly(o.id);
  assert.ok(Date.now() - started < 1000, "returned without waiting");
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
  assert.equal(logs().length, 2);
});

test("background recovery 1/3: if after() never ran (worker died after persisting), the retry job delivers both events", async () => {
  const o = await orderOf(); attribution(o.id);
  await confirmOnly(o.id);
  discardAfter(); // the process died before the scheduled kick
  assert.equal(calls.length, 0);
  const s = await runTrackingMaintenance();
  assert.equal(s.delivered.sent, 2);
  assert.equal(meta().length, 1); assert.equal(ga4().length, 1);
});

test("background recovery 2/3: a worker that crashed MID-delivery (stale SENDING claim) is recovered; a fresh claim is left alone", async () => {
  const o = await orderOf(); attribution(o.id);
  await confirmOnly(o.id); discardAfter();
  const ga = logOf(o.id, "GA4_MP");
  db.patch("trackingEventLog", ga.id as string, { status: "SENDING", attempts: 1, updatedAt: new Date() });
  await runTrackingMaintenance();
  assert.equal(ga4().length, 0, "fresh claim: some live worker owns it");
  db.patch("trackingEventLog", ga.id as string, { updatedAt: new Date(Date.now() - 5 * 60_000) });
  await runTrackingMaintenance();
  assert.equal(ga4().length, 1);
  assert.equal(logOf(o.id, "GA4_MP").status, "SENT");
  assert.equal(meta().length, 1, "Meta unaffected and sent once");
});

test("background recovery 3/3: if even persisting the event fails, the confirmation still succeeds and the job back-fills it from the order's CONFIRMED history", async () => {
  const o = await orderOf(); attribution(o.id);
  // The fake DB builds a fresh table delegate on every access, so the fault is injected by wrapping the installed DB.
  const realDb = (globalThis as any).__TEST_DB__;
  (globalThis as any).__TEST_DB__ = new Proxy(realDb, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return key === "trackingEventLog" ? { ...value, createMany: async () => { throw new Error("db down"); } } : value;
    },
  });
  try { await confirmOnly(o.id); } finally { (globalThis as any).__TEST_DB__ = realDb; }
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
  assert.equal(logs().length, 0);
  const s = await runTrackingMaintenance();
  assert.equal(s.queued, 1);
  assert.equal(meta().length, 1); assert.equal(ga4().length, 1);
  await runTrackingMaintenance(); // and it does not duplicate
  assert.equal(calls.length, 2);
  assert.equal(logs().length, 2);
});

// ================================================================================================ GA4 purchase

test("GA4 server purchase: transaction_id, BDT, value, tax, shipping, coupon and items come from the DATABASE order; secret only in the URL; no customer data", async () => {
  const o = await orderOf("p-standard", 2); attribution(o.id);
  db.insert("coupon", { id: "cp1", code: "WELCOME10" });
  db.patch("order", o.id, { couponId: "cp1", taxTotal: 20, shippingTotal: 70 });
  await confirm(o.id);

  assert.equal(ga4().length, 1);
  const { url, body } = ga4()[0];
  assert.equal(url, `https://www.google-analytics.com/mp/collect?measurement_id=G-ABCD1234&api_secret=${encodeURIComponent(GA4_SECRET)}`);
  assert.equal(body.client_id, "1234567890.1700000000");
  const p = body.events[0].params;
  const row = db.get("order", o.id);
  assert.equal(body.events[0].name, "purchase");
  assert.equal(p.transaction_id, o.orderNumber);
  assert.equal(p.currency, "BDT");
  assert.equal(p.tax, 20); assert.equal(p.shipping, 70); assert.equal(p.coupon, "WELCOME10");
  assert.equal(p.value, Math.round((Number(row.total) - 70 - 20) * 100) / 100);
  assert.deepEqual(p.items, [{ item_id: "p-standard", item_name: row.items ? undefined : db.rows("orderItem")[0].productName, price: 1800, quantity: 2 }].map((i) => ({ ...i, item_name: db.rows("orderItem")[0].productName })));
  assert.equal(p.session_id, "1700000000");
  assert.ok(!JSON.stringify(body).includes(GA4_SECRET) && !JSON.stringify(body).includes("buyer@example.com"));
  const log = logOf(o.id, "GA4_MP");
  assert.equal(log.status, "SENT"); assert.equal(log.attempts, 1); assert.equal(log.eventId, purchaseEventId(o.orderNumber));
});

test("GA4 purchase is never duplicated: re-enqueue, repeat delivery, the job and later status changes add no second request; one row per destination", async () => {
  const o = await orderOf(); attribution(o.id);
  await confirm(o.id);
  assert.equal(ga4().length, 1);
  assert.equal((await enqueuePurchaseEvent(o.id)).reason, "already_queued");
  assert.equal(await deliverTrackingEvent(logOf(o.id, "GA4_MP").id as string), "not_claimed");
  await runTrackingMaintenance(); await drainAfter();
  for (const s of ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) await move(o.id, s);
  await runTrackingMaintenance();
  assert.equal(ga4().length, 1); assert.equal(meta().length, 1);
  assert.equal(logs().filter((l) => l.destination === "GA4_MP").length, 1);
  assert.equal(logs().length, 2);
});

test("single-sender policy: exactly ONE GA4 purchase reaches GA4 whether or not the server is configured (browser XOR server, never both)", async () => {
  // Server configured -> the confirmation page omits the browser GA4 purchase.
  assert.equal(await isGa4ServerPurchaseActive(), true);
  const o = await orderOf(); attribution(o.id); await confirm(o.id);
  const items = [{ id: "p-standard", name: "n", price: 1800, quantity: 1 }];
  const browserFor = (serverActive: boolean) => purchaseEvent({ orderNumber: o.orderNumber, total: 1800, shipping: 0, tax: 0, items }, purchaseEventId(o.orderNumber), { includeGa4: !serverActive }).ga4 ? 1 : 0;
  assert.equal(browserFor(true) + ga4().length, 1);

  // No API secret -> server inactive, browser is the (only) sender and no server request exists.
  delete process.env.GA4_API_SECRET;
  assert.equal(await isGa4ServerPurchaseActive(), false);
  calls = []; db.remove("trackingEventLog", () => true);
  const p = await orderOf(); await confirm(p.id);
  assert.equal(ga4().length, 0);
  assert.equal(browserFor(false) + ga4().length, 1);

  // Validation mode records nothing at Google, so the browser keeps sending.
  process.env.GA4_API_SECRET = GA4_SECRET; process.env.GA4_MP_DEBUG = "true";
  assert.equal(await isGa4ServerPurchaseActive(), false);
});

test("GA4 is never sent without consent, nor without a client id (never invented); Meta is unaffected by either", async () => {
  db.patch("storeSettings", "singleton", { consentMode: "OPT_IN" });
  const unknown = await orderOf(); attribution(unknown.id, { consentState: "UNKNOWN", gaClientId: null, gaSessionId: null, consentRef: null, clientIp: null, clientUserAgent: null, fbp: null });
  const denied = await orderOf(); attribution(denied.id, { consentState: "DENIED", gaClientId: null, gaSessionId: null, consentRef: null, clientIp: null, clientUserAgent: null, fbp: null });
  const noClient = await orderOf(); attribution(noClient.id, { gaClientId: null, gaSessionId: null });
  const granted = await orderOf(); attribution(granted.id);
  for (const o of [unknown, denied, noClient, granted]) await confirm(o.id);

  for (const o of [unknown, denied]) for (const d of ["GA4_MP", "META_CAPI"]) { assert.equal(logOf(o.id, d).status, "SKIPPED"); assert.equal(logOf(o.id, d).skipReason, "consent_not_granted"); }
  assert.equal(logOf(noClient.id, "GA4_MP").skipReason, "no_client_id");
  assert.equal(logOf(noClient.id, "META_CAPI").status, "SENT");
  assert.equal(logOf(granted.id, "GA4_MP").status, "SENT");
  assert.equal(ga4().length, 1); assert.equal(meta().length, 2);
});

test("GA4 window: an event older than 71 h is skipped (event_too_old, would be silently re-dated by Google) while Meta (7 days) still sends", async () => {
  const o = await orderOf(); attribution(o.id);
  db.patch("order", o.id, { status: "CONFIRMED" });
  await enqueuePurchaseEvent(o.id, { eventTime: new Date(Date.now() - 73 * 3_600_000) });
  await runTrackingMaintenance();
  assert.equal(logOf(o.id, "GA4_MP").skipReason, "event_too_old");
  assert.equal(logOf(o.id, "META_CAPI").status, "SENT");
  assert.equal(ga4().length, 0);
});

test("validation mode (GA4_MP_DEBUG): goes to the debug endpoint; a valid event is SKIPPED validation_only (never SENT); an invalid one FAILS with Google's message", async () => {
  process.env.GA4_MP_DEBUG = "true";
  const a = await orderOf(); attribution(a.id);
  ga4Respond = () => new Response(JSON.stringify({ validationMessages: [] }), { status: 200 });
  await confirm(a.id);
  assert.ok(ga4()[0].url.includes("/debug/mp/collect"));
  assert.equal(logOf(a.id, "GA4_MP").status, "SKIPPED");
  assert.equal(logOf(a.id, "GA4_MP").skipReason, "validation_only");

  const b = await orderOf(); attribution(b.id);
  ga4Respond = () => new Response(JSON.stringify({ validationMessages: [{ fieldPath: "events[0].params.items", description: "items required", validationCode: "VALUE_REQUIRED" }] }), { status: 200 });
  await confirm(b.id);
  assert.equal(logOf(b.id, "GA4_MP").status, "FAILED");
  assert.match(logOf(b.id, "GA4_MP").errorMessage as string, /items required/);
});

// ================================================================================================ delivery failures

test("Meta and GA4 fail independently: one down never blocks, duplicates or hides the other; identifiers are kept until BOTH have settled", async () => {
  const o = await orderOf(); attribution(o.id);
  metaRespond = status(503);
  await confirm(o.id);
  assert.equal(logOf(o.id, "GA4_MP").status, "SENT");
  assert.equal(logOf(o.id, "META_CAPI").status, "PENDING");
  assert.ok(logOf(o.id, "META_CAPI").nextAttemptAt);
  let a = db.rows("orderAttribution")[0];
  assert.equal(a.clientIp, "203.0.113.7", "Meta still needs the IP / user agent");
  assert.equal(a.gaClientId, "1234567890.1700000000", "not erased while an event is still waiting");

  metaRespond = metaOk;
  await runTrackingMaintenance({ now: new Date(Date.now() + 3_600_000) });
  assert.equal(logOf(o.id, "META_CAPI").status, "SENT");
  assert.equal(ga4().length, 1, "GA4 was not re-sent");
  a = db.rows("orderAttribution")[0];
  assert.deepEqual([a.clientIp, a.clientUserAgent, a.gaClientId, a.gaSessionId], [null, null, null, null]);
  assert.ok(a.contactScrubbedAt);
});

test("GA4 failures: transient -> retry with back-off, permanent -> FAILED (no auto-retry), admin retry gets one attempt; the API secret is never stored", async () => {
  const t = await orderOf(); attribution(t.id);
  ga4Respond = status(500);
  await confirm(t.id);
  let row = logOf(t.id, "GA4_MP");
  assert.equal(row.status, "PENDING"); assert.equal(row.errorCode, "500"); assert.ok(row.nextAttemptAt);

  const p = await orderOf(); attribution(p.id);
  ga4Respond = () => new Response(JSON.stringify({ error: `bad request ?api_secret=${GA4_SECRET}` }), { status: 400 });
  await confirm(p.id);
  row = logOf(p.id, "GA4_MP");
  assert.equal(row.status, "FAILED");
  assert.ok(!JSON.stringify(logs()).includes(GA4_SECRET), "the secret appears in no stored row");
  const forOrder = (n: string) => ga4().filter((c) => c.body.events[0].params.transaction_id === n).length;
  assert.equal(forOrder(p.orderNumber), 1);
  await runTrackingMaintenance({ now: new Date(Date.now() + 86_400_000) });
  assert.equal(forOrder(p.orderNumber), 1, "the permanently FAILED event is not retried automatically");
  assert.equal(logOf(p.id, "GA4_MP").attempts, 1);
  assert.equal(forOrder(t.orderNumber), 2, "whereas the transiently failed one is (back-off elapsed)");

  // Regression: Meta succeeded AFTER GA4 had failed. The failed event must keep what it needs for an admin retry (client id), not be scrubbed.
  assert.equal(logOf(p.id, "META_CAPI").status, "SENT");
  const kept = db.rows("orderAttribution").find((r) => r.orderId === p.id)!;
  assert.equal(kept.gaClientId, "1234567890.1700000000");
  ga4Respond = ga4Ok;
  assert.equal(await retryTrackingEvent(row.id as string), "sent");
  assert.equal(db.rows("orderAttribution").find((r) => r.orderId === p.id)!.gaClientId, null, "and is erased once nothing can still be delivered");
  assert.equal(logOf(p.id, "GA4_MP").status, "SENT");
  assert.equal(await retryTrackingEvent(row.id as string), "not_claimed");

  const n = await orderOf(); attribution(n.id);
  globalThis.fetch = (async () => { throw new TypeError(`fetch failed https://x/?api_secret=${GA4_SECRET}`); }) as never;
  await confirm(n.id);
  assert.equal(logOf(n.id, "GA4_MP").errorCode, "network");
  assert.ok(!JSON.stringify(logs()).includes(GA4_SECRET));
  assert.equal(db.get("order", n.id).status, "CONFIRMED");
});

// ================================================================================================ consent withdrawal

const orderRowSnapshot = (id: string) => JSON.stringify(db.get("order", id));

test("GUEST withdrawal BEFORE delivery: pending Meta + GA4 events become SKIPPED consent_withdrawn and are never sent; stored identifiers are erased; the order is untouched", async () => {
  const o = await orderOf(); attribution(o.id, { userId: null });
  await confirmOnly(o.id); // persisted, not yet delivered
  const orderBefore = orderRowSnapshot(o.id);
  const ordersBefore = db.rows("order").length;

  const r = await withdrawTrackingConsent({ consentRef: REF_A });
  assert.deepEqual(r, { attributionsCleared: 1, eventsSkipped: 2 });
  assert.ok(logs().every((l) => l.status === "SKIPPED" && l.skipReason === "consent_withdrawn"));
  await drainAfter(); await runTrackingMaintenance({ now: new Date(Date.now() + 3_600_000) });
  assert.equal(calls.length, 0, "nothing was sent after the withdrawal");

  const a = db.rows("orderAttribution")[0];
  assert.equal(a.consentState, "DENIED"); assert.ok(a.consentWithdrawnAt);
  for (const k of ["firstTouch", "lastTouch", "fbc", "fbp", "clientIp", "clientUserAgent", "gaClientId", "gaSessionId", "consentRef"]) assert.equal(a[k] ?? null, null, k);
  assert.equal(orderRowSnapshot(o.id), orderBefore, "the business record is byte-for-byte unchanged");
  assert.equal(db.rows("order").length, ordersBefore);
  assert.equal(db.get("order", o.id).email, "buyer@example.com");

  assert.deepEqual(await withdrawTrackingConsent({ consentRef: REF_A }), { attributionsCleared: 0, eventsSkipped: 0 }, "idempotent (the reference was erased)");
});

test("AUTHENTICATED withdrawal: by account, even from another device with no reference; other customers' orders are untouched", async () => {
  const mine = await orderOf(); attribution(mine.id, { userId: "cust", consentRef: REF_A });
  const other = await orderOf(); attribution(other.id, { userId: "someone-else", consentRef: REF_B });
  await confirmOnly(mine.id); await confirmOnly(other.id);

  const r = await withdrawTrackingConsent({ consentRef: null, userId: "cust" });
  assert.equal(r.eventsSkipped, 2);
  assert.ok(logs().filter((l) => l.orderId === mine.id).every((l) => l.skipReason === "consent_withdrawn"));
  assert.ok(logs().filter((l) => l.orderId === other.id).every((l) => l.status === "PENDING"));
  await drainAfter();
  assert.equal(meta().length, 1); assert.equal(ga4().length, 1);
  assert.equal(meta()[0].body.data[0].custom_data.order_id, other.orderNumber);
});

test("a reference only reaches the orders that carry it", async () => {
  const a = await orderOf(); attribution(a.id, { userId: null, consentRef: REF_A });
  const b = await orderOf(); attribution(b.id, { userId: null, consentRef: REF_B });
  await confirmOnly(a.id); await confirmOnly(b.id);
  await withdrawTrackingConsent({ consentRef: REF_A });
  assert.ok(logs().filter((l) => l.orderId === a.id).every((l) => l.status === "SKIPPED"));
  assert.ok(logs().filter((l) => l.orderId === b.id).every((l) => l.status === "PENDING"));
  assert.equal(db.rows("orderAttribution").find((r) => r.orderId === b.id)!.consentRef, REF_B);
  // Invalid / empty input does nothing at all.
  assert.deepEqual(await withdrawTrackingConsent({ consentRef: "x", userId: null }), { attributionsCleared: 0, eventsSkipped: 0 });
  assert.deepEqual(await withdrawTrackingConsent({}), { attributionsCleared: 0, eventsSkipped: 0 });
});

test("withdrawal AFTER delivery: sent events stay SENT (a delivered event cannot be recalled), no new request is made, identifiers are still erased", async () => {
  const o = await orderOf(); attribution(o.id);
  await confirm(o.id);
  assert.equal(meta().length + ga4().length, 2);
  const sentAt = (logOf(o.id, "META_CAPI").sentAt as Date).getTime();

  const r = await withdrawTrackingConsent({ consentRef: REF_A });
  assert.equal(r.eventsSkipped, 0, "nothing undelivered to stop");
  assert.ok(logs().every((l) => l.status === "SENT"), "history is not rewritten");
  assert.equal((logOf(o.id, "META_CAPI").sentAt as Date).getTime(), sentAt);
  await runTrackingMaintenance({ now: new Date(Date.now() + 3_600_000) });
  assert.equal(meta().length + ga4().length, 2);
  assert.equal(db.rows("orderAttribution")[0].consentState, "DENIED");
});

test("withdrawal also stops FAILED events from being retried (job or admin button)", async () => {
  const o = await orderOf(); attribution(o.id);
  ga4Respond = status(400);
  await confirm(o.id);
  const failed = logOf(o.id, "GA4_MP");
  assert.equal(failed.status, "FAILED");
  await withdrawTrackingConsent({ consentRef: REF_A });
  assert.equal(logOf(o.id, "GA4_MP").skipReason, "consent_withdrawn");
  ga4Respond = ga4Ok;
  assert.equal(await retryTrackingEvent(failed.id as string), "not_claimed");
  assert.equal(ga4().length, 1);
});

test("a withdrawal that arrives WHILE an event is being prepared still wins (consent is re-checked immediately before the request)", async () => {
  const o = await orderOf(); attribution(o.id);
  await confirmOnly(o.id); discardAfter();
  let reads = 0;
  const real = prisma as any;
  const proxied = new Proxy(real, {
    get(target, key) {
      if (key !== "orderAttribution") return target[key];
      return new Proxy(target.orderAttribution, {
        get(t, k) {
          if (k !== "findUnique") return typeof t[k] === "function" ? t[k].bind(t) : t[k];
          return async (args: unknown) => {
            reads += 1;
            if (reads === 2) await withdrawTrackingConsent({ consentRef: REF_A }, { db: real }); // arrives after the first check, before the send
            return t.findUnique(args);
          };
        },
      });
    },
  });
  const outcome = await deliverTrackingEvent(logOf(o.id, "GA4_MP").id as string, { db: proxied });
  assert.equal(outcome, "skipped");
  assert.equal(ga4().length, 0);
  assert.equal(logOf(o.id, "GA4_MP").skipReason, "consent_withdrawn");
});

test("snapshot at checkout: GA client id / session / consent reference are captured only when consent permits AND the GA4 server purchase is configured", async () => {
  const jar: Map<string, { value: string }> = (globalThis as any).__TEST_COOKIES__;
  const set = (k: string, v: string) => jar.set(k, { value: v });
  set("_ga", "GA1.1.1234567890.1700000000"); set("_ga_ABCD1234", "GS1.1.1700000000.3.1.1700000100.60.0.0");
  set("gp_cref", REF_A); set("gp_consent", "granted");
  (globalThis as any).__TEST_HEADERS__ = { "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.7" };

  const o = await orderOf();
  await snapshotOrderAttribution({ id: o.id, userId: "cust", orderNumber: o.orderNumber }, "OPT_IN");
  let a = db.rows("orderAttribution").find((r) => r.orderId === o.id)!;
  assert.deepEqual([a.gaClientId, a.gaSessionId, a.consentRef, a.consentState], ["1234567890.1700000000", "1700000000", REF_A, "GRANTED"]);

  // GA4 server purchase not configured -> the GA identifiers are not collected at all.
  delete process.env.GA4_API_SECRET; db.remove("orderAttribution", () => true);
  await snapshotOrderAttribution({ id: o.id, userId: "cust", orderNumber: o.orderNumber }, "OPT_IN");
  a = db.rows("orderAttribution")[0];
  assert.deepEqual([a.gaClientId, a.gaSessionId, a.consentRef], [null, null, REF_A]);

  // No consent -> nothing but the state; forged cookies are rejected.
  process.env.GA4_API_SECRET = GA4_SECRET; db.remove("orderAttribution", () => true); jar.delete("gp_consent");
  await snapshotOrderAttribution({ id: o.id, userId: "cust", orderNumber: o.orderNumber }, "OPT_IN");
  a = db.rows("orderAttribution")[0];
  assert.deepEqual([a.consentState, a.gaClientId, a.consentRef, a.clientIp], ["UNKNOWN", null, null, null]);
  db.remove("orderAttribution", () => true); set("gp_consent", "granted"); set("_ga", "GA1.1.evil.1"); set("gp_cref", "not valid!");
  await snapshotOrderAttribution({ id: o.id, userId: "cust", orderNumber: o.orderNumber }, "OPT_IN");
  a = db.rows("orderAttribution")[0];
  assert.deepEqual([a.gaClientId, a.consentRef], [null, null]);
});
