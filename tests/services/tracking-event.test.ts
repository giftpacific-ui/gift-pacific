/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, seedAdmins, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { InvalidOrderTransitionError } from "@/lib/order-transitions";
import { deliverTrackingEvent, enqueuePurchaseEvent, retryTrackingEvent, runTrackingMaintenance } from "@/server/services/tracking-event.service";
import { snapshotOrderAttribution } from "@/server/services/order-attribution.service";
import { getTrackingDiagnostics } from "@/server/services/tracking-diagnostics.service";
import { sha256 } from "@/lib/analytics/server-events";
import { purchaseEventId } from "@/lib/analytics/ids";
import { purchaseEvent } from "@/lib/analytics/payloads";
import { serializeAttributionCookie, touchFromLocation } from "@/lib/analytics/attribution";

const TOKEN = "EAAGsecrettokenvalue1234567890";
const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
let db: FakeDb;
let calls: { url: string; body: any }[];
let respond: () => Response | Promise<Response>;
const ok = () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: "TRACE" }), { status: 200 });
const fail = (status: number, code?: number) => () => new Response(JSON.stringify({ error: { code, message: "meta says no" } }), { status });

beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("storeSettings", "singleton", { metaPixelId: "123456789", consentMode: "OFF" });
  process.env.META_CONVERSIONS_API_TOKEN = TOKEN;
  process.env.CRON_SECRET = "c".repeat(32);
  delete process.env.META_CAPI_TEST_EVENT_CODE;
  (globalThis as any).__TEST_COOKIES__.clear();
  (globalThis as any).__TEST_HEADERS__ = {};
  calls = []; respond = ok;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); return respond(); }) as never;
});
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...realEnv }; });

const logs = () => db.rows("trackingEventLog");
const orderOf = async (productId = "p-standard", quantity = 1) => {
  await runAs({ sub: "cust" }, () => addItemToCart({ productId, variantId: null, quantity }));
  return runAs({ sub: "cust" }, () => placeOrder(emptyCheckout));
};
const move = (id: string, to: string) => adminUpdateOrderStatus(id, to as never, undefined, TEST_ADMIN);
const attribution = (id: string, over: Record<string, unknown> = {}) =>
  db.insert("orderAttribution", { id: `attr-${id}`, orderId: id, userId: "cust", consentState: "NOT_REQUIRED", fbc: null, fbp: "fb.1.1700000000000.1234567890", clientIp: "203.0.113.7", clientUserAgent: "Mozilla/5.0", contactScrubbedAt: null, createdAt: new Date(), ...over });

test("CREATING an order is not a Purchase: no event row, no request to Meta", async () => {
  const o = await orderOf();
  assert.equal(db.get("order", o.id).status, "PENDING");
  assert.equal(logs().length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await enqueuePurchaseEvent(o.id), { logId: null, reason: "order_not_eligible" }); // even asking for it explicitly
  assert.equal(logs().length, 0);
});

test("CONFIRMING the order sends exactly one Purchase, built from the DATABASE order, with the browser's event id; audit row is SENT", async () => {
  const o = await orderOf("p-standard", 2);
  attribution(o.id);
  db.patch("order", o.id, { userId: "cust" });
  await move(o.id, "CONFIRMED");

  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.equal(url, "https://graph.facebook.com/v25.0/123456789/events");
  assert.ok(!JSON.stringify(url).includes(TOKEN));
  assert.equal(body.access_token, TOKEN);
  const e = body.data[0];
  assert.equal(e.event_name, "Purchase");
  assert.equal(e.event_id, purchaseEventId(o.orderNumber));
  assert.equal(e.action_source, "website");
  assert.equal(e.custom_data.order_id, o.orderNumber);
  assert.equal(e.custom_data.currency, "BDT");
  assert.equal(e.custom_data.value, Number(db.get("order", o.id).total)); // value comes from the order row, nothing else
  assert.deepEqual(e.custom_data.content_ids, ["p-standard"]);
  assert.deepEqual(e.custom_data.contents, [{ id: "p-standard", quantity: 2, item_price: 1800 }]);
  assert.deepEqual(e.user_data.em, [sha256("buyer@example.com")]);
  assert.deepEqual(e.user_data.ph, [sha256("8801711000000")]);
  assert.equal(e.user_data.client_ip_address, "203.0.113.7");
  assert.ok(!JSON.stringify(body.data).includes("buyer@example.com"), "no plaintext email");

  const [row] = logs();
  assert.equal(logs().length, 1);
  assert.equal(row.status, "SENT");
  assert.equal(row.attempts, 1);
  assert.equal(row.orderNumber, o.orderNumber);
  assert.equal(row.fbtraceId, "TRACE");
  assert.equal(row.httpStatus, 200);
  assert.ok(row.sentAt);
  // Browser and server share ONE event id, so Meta counts them once.
  const browser = purchaseEvent({ orderNumber: o.orderNumber, total: 1, shipping: 0, tax: 0, items: [] }, purchaseEventId(o.orderNumber));
  assert.equal(browser.eventId, e.event_id);
  assert.equal(browser.meta?.params.order_id, e.custom_data.order_id);
});

test("a Purchase is NEVER duplicated: re-enqueue, repeat delivery, the retry job, later status changes and a second confirm all add nothing", async () => {
  const o = await orderOf();
  await move(o.id, "CONFIRMED");
  assert.equal(calls.length, 1);
  const id = logs()[0].id as string;

  assert.equal((await enqueuePurchaseEvent(o.id)).reason, "already_queued");
  assert.equal(await deliverTrackingEvent(id), "not_claimed");
  await runTrackingMaintenance();
  await assert.rejects(move(o.id, "CONFIRMED"), InvalidOrderTransitionError); // CONFIRMED -> CONFIRMED is not a transition
  for (const s of ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) await move(o.id, s);
  await runTrackingMaintenance();

  assert.equal(calls.length, 1);
  assert.equal(logs().length, 1);
});

test("two workers racing for the same pending event: exactly one request", async () => {
  const o = await orderOf();
  db.patch("order", o.id, { status: "CONFIRMED" });
  const { logId } = await enqueuePurchaseEvent(o.id);
  const results = await Promise.all([deliverTrackingEvent(logId!), deliverTrackingEvent(logId!), deliverTrackingEvent(logId!)]);
  assert.deepEqual(results.filter((r) => r === "sent").length, 1);
  assert.equal(calls.length, 1);
});

test("cancelled order: a Purchase still waiting for delivery is SKIPPED, not sent; one already accepted is left alone", async () => {
  // (a) delivery failed transiently, then the order was cancelled
  const a = await orderOf();
  respond = fail(500);
  await move(a.id, "CONFIRMED");
  assert.equal(logs()[0].status, "PENDING");
  assert.equal(calls.length, 1);
  await move(a.id, "CANCELLED");
  respond = ok;
  const summary = await runTrackingMaintenance({ now: new Date(Date.now() + 3_600_000) });
  assert.equal(summary.delivered.skipped, 1);
  assert.equal(calls.length, 1, "no second request");
  assert.equal(logs()[0].status, "SKIPPED");
  assert.equal(logs()[0].skipReason, "order_not_eligible");

  // (b) already SENT, then cancelled: the audit row is untouched and nothing new is emitted
  const b = await orderOf();
  await move(b.id, "CONFIRMED");
  const before = calls.length;
  await move(b.id, "CANCELLED");
  await runTrackingMaintenance({ now: new Date(Date.now() + 3_600_000) });
  assert.equal(calls.length, before);
  assert.equal(logs().find((l) => l.orderId === b.id)!.status, "SENT");
});

test("marketplace / non-website orders never produce a Purchase, even if they carry a CONFIRMED history row", async () => {
  const o = await orderOf();
  await move(o.id, "CONFIRMED");
  calls.length = 0; db.remove("trackingEventLog", () => true);
  db.patch("order", o.id, { channelId: "channel_amazon" });
  assert.deepEqual(await enqueuePurchaseEvent(o.id), { logId: null, reason: "not_website_order" });
  await runTrackingMaintenance();
  assert.equal(logs().length, 0);
  assert.equal(calls.length, 0);
});

test("failures never break the order operation: Meta down or the network failing leaves the order CONFIRMED and the event queued for retry", async () => {
  const a = await orderOf();
  respond = fail(503);
  await move(a.id, "CONFIRMED");
  assert.equal(db.get("order", a.id).status, "CONFIRMED");
  assert.equal(logs()[0].status, "PENDING");
  assert.ok(logs()[0].nextAttemptAt);

  const b = await orderOf();
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as never;
  await move(b.id, "CONFIRMED");
  assert.equal(db.get("order", b.id).status, "CONFIRMED");
  assert.equal(logs().find((l) => l.orderId === b.id)!.errorCode, "network");
});

test("retries use exponential back-off, are never early, and stop after the attempt limit; the event id never changes", async () => {
  const o = await orderOf();
  respond = fail(500);
  await move(o.id, "CONFIRMED");
  const id = logs()[0].id as string;
  const eventId = logs()[0].eventId;
  const t0 = Date.now();

  assert.equal(await deliverTrackingEvent(id, { now: new Date(t0 + 1000) }), "not_claimed", "not due yet (back-off 60s)");
  const delays: number[] = [];
  let now = t0;
  for (let attempt = 2; attempt <= 6; attempt++) {
    now = (logs()[0].nextAttemptAt as Date).getTime();
    const outcome = await deliverTrackingEvent(id, { now: new Date(now) });
    assert.equal(outcome, attempt < 6 ? "retry_scheduled" : "failed", `attempt ${attempt}`);
    if (attempt < 6) delays.push((logs()[0].nextAttemptAt as Date).getTime() - now);
  }
  assert.deepEqual(delays, [300_000, 1_800_000, 7_200_000, 21_600_000]); // after attempts 2,3,4,5 (attempt 1 -> 60s was checked above)
  assert.equal(logs()[0].status, "FAILED");
  assert.equal(logs()[0].attempts, 6);
  assert.equal(calls.length, 6);
  assert.equal(logs()[0].eventId, eventId);
  assert.equal(await deliverTrackingEvent(id, { now: new Date(now + 86_400_000) }), "not_claimed", "FAILED rows are not retried automatically");
  assert.equal(calls.length, 6);
});

test("a permanent error (invalid token) is not retried automatically; the stored error holds no token; an admin retry gets exactly one more attempt", async () => {
  const o = await orderOf();
  respond = () => new Response(JSON.stringify({ error: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } }), { status: 400 });
  await move(o.id, "CONFIRMED");
  const row = logs()[0];
  assert.equal(row.status, "FAILED");
  assert.equal(row.errorCode, "190");
  assert.ok(!JSON.stringify(row).includes(TOKEN), "token never stored");
  assert.equal(calls.length, 1);

  respond = ok; // admin fixed the token
  assert.equal(await retryTrackingEvent(row.id as string), "sent");
  assert.equal(logs()[0].status, "SENT");
  assert.equal(calls.length, 2);
  assert.equal(await retryTrackingEvent(row.id as string), "not_claimed", "a SENT event cannot be re-sent");
  assert.equal(calls.length, 2);

  // a manual retry that fails again ends FAILED (one attempt), never silently rescheduled
  const p = await orderOf();
  respond = fail(500);
  await move(p.id, "CONFIRMED");
  const r2 = logs().find((l) => l.orderId === p.id)!;
  db.patch("trackingEventLog", r2.id as string, { status: "FAILED" });
  assert.equal(await retryTrackingEvent(r2.id as string), "failed");
});

test("a crashed worker's claim is recovered after the stale window; a fresh claim is left alone", async () => {
  const o = await orderOf();
  db.patch("order", o.id, { status: "CONFIRMED" });
  const base = { destination: "META_CAPI", eventName: "Purchase", orderId: o.id, orderNumber: o.orderNumber, eventId: purchaseEventId(o.orderNumber), attempts: 1, eventTime: new Date(), nextAttemptAt: null };
  const row = db.insert("trackingEventLog", { id: "log-1", ...base, status: "SENDING", updatedAt: new Date() });
  await runTrackingMaintenance();
  assert.equal(calls.length, 0, "fresh claim untouched");
  db.patch("trackingEventLog", row.id as string, { updatedAt: new Date(Date.now() - 5 * 60_000) });
  await runTrackingMaintenance();
  assert.equal(calls.length, 1);
  assert.equal(logs()[0].status, "SENT");
});

test("Meta's 7-day window: an event that waited too long is SKIPPED (event_too_old), not sent", async () => {
  const o = await orderOf();
  db.patch("order", o.id, { status: "CONFIRMED" });
  const { logId } = await enqueuePurchaseEvent(o.id, { eventTime: new Date(Date.now() - 8 * 86_400_000) });
  assert.equal(await deliverTrackingEvent(logId!), "skipped");
  assert.equal(logs()[0].skipReason, "event_too_old");
  assert.equal(calls.length, 0);
});

test("missing configuration: nothing is queued or sent; once configured, the retry job back-fills the confirmed order exactly once", async () => {
  delete process.env.META_CONVERSIONS_API_TOKEN;
  const o = await orderOf();
  await move(o.id, "CONFIRMED");
  assert.equal(logs().length, 0);
  assert.equal(calls.length, 0);
  assert.equal(db.get("order", o.id).status, "CONFIRMED", "order unaffected");

  process.env.META_CONVERSIONS_API_TOKEN = TOKEN;
  const s = await runTrackingMaintenance();
  assert.equal(s.queued, 1);
  assert.equal(calls.length, 1);
  await runTrackingMaintenance();
  assert.equal(calls.length, 1);
  assert.equal(logs().length, 1);
  assert.equal(logs()[0].status, "SENT");
});

test("consent (OPT_IN store): sent only when the order was placed with an explicit grant; unknown / denied are SKIPPED with a reason", async () => {
  db.patch("storeSettings", "singleton", { consentMode: "OPT_IN" });
  const granted = await orderOf(); attribution(granted.id, { consentState: "GRANTED" });
  const unknown = await orderOf(); attribution(unknown.id, { consentState: "UNKNOWN", clientIp: null, clientUserAgent: null, fbp: null });
  const denied = await orderOf(); attribution(denied.id, { consentState: "DENIED", clientIp: null, clientUserAgent: null, fbp: null });
  const noRow = await orderOf();
  for (const o of [granted, unknown, denied, noRow]) await move(o.id, "CONFIRMED");

  const by = (o: { id: string }) => logs().find((l) => l.orderId === o.id)!;
  assert.equal(by(granted).status, "SENT");
  for (const o of [unknown, denied, noRow]) { assert.equal(by(o).status, "SKIPPED"); assert.equal(by(o).skipReason, "consent_not_granted"); }
  assert.equal(calls.length, 1);
});

test("consent (OFF store): the documented default sends, but an explicit denial is still honoured", async () => {
  const a = await orderOf(); attribution(a.id, { consentState: "NOT_REQUIRED" });
  const b = await orderOf(); attribution(b.id, { consentState: "DENIED", clientIp: null, clientUserAgent: null });
  await move(a.id, "CONFIRMED"); await move(b.id, "CONFIRMED");
  assert.equal(logs().find((l) => l.orderId === a.id)!.status, "SENT");
  assert.equal(logs().find((l) => l.orderId === b.id)!.skipReason, "consent_not_granted");
});

test("customer IP / user agent are removed once the event is delivered, and from old attributions by the maintenance job", async () => {
  const o = await orderOf();
  attribution(o.id);
  await move(o.id, "CONFIRMED");
  assert.equal(calls[0].body.data[0].user_data.client_ip_address, "203.0.113.7"); // used for matching...
  const a = db.rows("orderAttribution")[0];
  assert.equal(a.clientIp, null); // ...then gone
  assert.equal(a.clientUserAgent, null);
  assert.ok(a.contactScrubbedAt);

  const stale = attribution("old-order", { createdAt: new Date(Date.now() - 9 * 86_400_000) });
  await runTrackingMaintenance();
  assert.equal(db.get("orderAttribution", stale.id as string).clientIp, null);
});

test("attribution snapshot: validated cookie -> stored once; first touch is never overwritten by a second snapshot", async () => {
  const jar: Map<string, { value: string }> = (globalThis as any).__TEST_COOKIES__;
  const touch = touchFromLocation({ pathname: "/shop", search: "?utm_source=fb&utm_campaign=Eid&campaign_id=120211111111&fbclid=IwAR0abcdefghijklmnop", referrer: "https://l.facebook.com/", ownHost: "shop.test", now: Date.now() })!;
  jar.set("gp_attr", { value: serializeAttributionCookie({ v: 1, first: touch, last: touch }) });
  jar.set("_fbp", { value: "fb.1.1700000000000.1234567890" });
  jar.set("gp_consent", { value: "granted" });
  (globalThis as any).__TEST_HEADERS__ = { "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.7, 10.0.0.1" };

  const o = await orderOf();
  await snapshotOrderAttribution({ id: o.id, userId: "cust", orderNumber: o.orderNumber }, "OPT_IN");
  const [a] = db.rows("orderAttribution");
  assert.equal(a.consentState, "GRANTED");
  assert.equal((a.firstTouch as any).campaign, "Eid");
  assert.equal((a.lastTouch as any).campaignId, "120211111111");
  assert.match(a.fbc as string, /^fb\.1\.\d+\.IwAR0abcdefghijklmnop$/);
  assert.equal(a.fbp, "fb.1.1700000000000.1234567890");
  assert.equal(a.clientIp, "203.0.113.7");
  assert.equal(a.userId, "cust");

  jar.set("gp_attr", { value: serializeAttributionCookie({ v: 1, first: { ...touch, campaign: "Other" } }) });
  await snapshotOrderAttribution({ id: o.id, userId: "cust", orderNumber: o.orderNumber }, "OPT_IN");
  assert.equal(db.rows("orderAttribution").length, 1);
  assert.equal((db.rows("orderAttribution")[0].firstTouch as any).campaign, "Eid", "original attribution preserved");
});

test("attribution snapshot under OPT_IN without a grant stores the consent state ONLY; a forged cookie is sanitised; OFF stores it all", async () => {
  const jar: Map<string, { value: string }> = (globalThis as any).__TEST_COOKIES__;
  jar.set("gp_attr", { value: serializeAttributionCookie({ v: 1, first: { at: Date.now(), source: "fb" } }) });
  (globalThis as any).__TEST_HEADERS__ = { "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.7" };
  const o = await orderOf();
  await snapshotOrderAttribution({ id: o.id, userId: null, orderNumber: o.orderNumber }, "OPT_IN"); // no gp_consent cookie
  const a = db.rows("orderAttribution")[0];
  assert.equal(a.consentState, "UNKNOWN");
  for (const k of ["firstTouch", "lastTouch", "fbc", "fbp", "clientIp", "clientUserAgent"]) assert.ok(a[k] == null, `${k} must not be stored`);

  const p = await orderOf();
  jar.set("gp_attr", { value: encodeURIComponent(JSON.stringify({ v: 1, first: { at: Date.now(), source: "<b>x</b>", campaignId: "1;DROP" } })) });
  await snapshotOrderAttribution({ id: p.id, userId: null, orderNumber: p.orderNumber }, "OFF");
  const b = db.rows("orderAttribution").find((r) => r.orderId === p.id)!;
  assert.equal(b.consentState, "NOT_REQUIRED");
  assert.equal((b.firstTouch as any).source, "bx/b"); // markup characters stripped
  assert.equal((b.firstTouch as any).campaignId, undefined);
});

test("diagnostics: counts and recent problems from the real log; the token and customer data never appear", async () => {
  const a = await orderOf(); await move(a.id, "CONFIRMED"); // SENT
  const b = await orderOf(); respond = fail(500); await move(b.id, "CONFIRMED"); // PENDING (retrying)
  const d = await getTrackingDiagnostics();
  assert.deepEqual(d.events.counts, { sent: 1, pending: 1, failed: 0, skipped: 0 });
  assert.ok(d.events.lastSentAt);
  assert.equal(d.events.recent.length, 1);
  assert.equal(d.events.recent[0].orderNumber, b.orderNumber);
  assert.equal(d.meta.capiState, "ready");
  const json = JSON.stringify(d);
  for (const secret of [TOKEN, "buyer@example.com", "1711000000", "c".repeat(32)]) assert.ok(!json.includes(secret), `leaked ${secret.slice(0, 6)}`);
});
