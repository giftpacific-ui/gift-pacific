/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { getOrderByNumberForCurrentUser, placeOrder } from "@/server/services/order.service";
import { getAdvancePanel, recheckOrderFraud, saveAdvanceSettings } from "@/server/services/advance.service";
import { getIntelligenceProviderStatuses, resetIntelligenceStateForTests, setIntelligenceAdaptersForTests, setPhoneVerifiedForTests } from "@/server/services/courier-intelligence.service";

/**
 * Checkout and admin recheck with the REAL Steadfast history adapter; only `fetch` is replaced (test-only). The response example is the one in
 * Steadfast's own published client README (tests/fixtures/steadfast-fraud-check/README.md), NOT a captured live response. These tests prove OUR rules;
 * the live Steadfast service has never been called.
 */
const DOCUMENTED = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/steadfast-fraud-check/documented-shape.json"), "utf8"));
const KEY = "sf-key-CHECKOUT-123";
const SECRET = "sf-secret-CHECKOUT-456";
const PHONE = "01712345678";
const ENV = ["FRAUD_CHECK_PROVIDER", "FRAUD_CHECK_ENABLED", "FRAUD_CHECK_CACHE_SECONDS", "FRAUD_CHECK_TIMEOUT_MS", "STEADFAST_API_KEY", "STEADFAST_API_SECRET", "STEADFAST_API_BASE_URL", "STEADFAST_ENABLED", "RATE_LIMIT_ENABLED"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let db: FakeDb;
let calls: { url: string; headers: any; method: string }[] = [];
let respond: (signal?: AbortSignal) => Promise<Response> = async () => Response.json(DOCUMENTED);

const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };

beforeEach(async () => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { FRAUD_CHECK_CACHE_SECONDS: "0", STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, RATE_LIMIT_ENABLED: "false" });
  calls = []; respond = async () => Response.json(DOCUMENTED);
  globalThis.fetch = (async (url: string, init: any) => { calls.push({ url: String(url), headers: init.headers, method: init.method }); return respond(init.signal); }) as never;
  setIntelligenceAdaptersForTests(undefined);              // the REAL adapter
  setPhoneVerifiedForTests(undefined);                     // the REAL default: no phone is verified
  resetIntelligenceStateForTests();
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("product", "p-standard", { stock: 100 });
  await saveAdvanceSettings(policy as never, "a1");
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch; setIntelligenceAdaptersForTests(undefined); setPhoneVerifiedForTests(undefined); resetIntelligenceStateForTests();
});

let n = 0;
const place = (phone = PHONE) => runAs(null, async () => {
  await addItemToCart({ productId: "p-standard", quantity: 1 });
  return placeOrder({ ...emptyCheckout, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXSTEAD${String(++n).padStart(5, "0")}` } as never);
});
const row = (id: string) => db.get("order", id);

test("checkout calls the DOCUMENTED Steadfast endpoint with the courier credentials and stores the evidence: 9 delivered of 24 is a low rate (standard advance + review)", async () => {
  const o = await place();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://portal.packzy.com/api/v1/fraud_check/${PHONE}`);     // NOT the earlier /fraud_check/score/{phone}
  assert.ok(!calls[0].url.includes("/score/"));
  assert.equal(calls[0].method, "GET");
  assert.deepEqual([calls[0].headers["Api-Key"], calls[0].headers["Secret-Key"]], [KEY, SECRET]);
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [38, 200, true]);   // 9 / (9 + 15) = 37.5% -> stored as 38
  const fc = (r.trustSnapshot as any).fraudCheck;
  assert.deepEqual([fc.status, fc.source, fc.provider, fc.delivered, fc.cancelled, fc.returned, fc.total, fc.phoneVerified], ["ok", "provider", "steadfast", 9, 15, null, 24, false]);
  assert.equal((r.trustSnapshot as any).score, 37.5);
  const text = JSON.stringify(r.trustSnapshot);
  for (const secret of [KEY, SECRET, PHONE, "1712345678"]) assert.ok(!text.includes(secret), `snapshot leaked ${secret}`);
  assert.equal(fc.phoneLast4, "5678");
});

test("an unusable answer, a rejected key, a rate limit, an outage and a timeout all fall back to unrated (standard advance, review) and never block the order", async () => {
  process.env.FRAUD_CHECK_TIMEOUT_MS = "500";
  const cases: [(s?: AbortSignal) => Promise<Response>, string][] = [
    [async () => Response.json({ delivered_count: 58, cancelled_count: 5 }), "invalid_response"],       // the field names the OLD adapter assumed are not accepted
    [async () => Response.json({ delivery_ratio: 92, cancellation_ratio: 7, volume_band: "high" }), "invalid_response"], // ratios only: nothing is estimated
    [async () => Response.json({}), "invalid_response"],
    [async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), "invalid_response"],
    [async () => new Response("{}", { status: 401 }), "auth_failed"],
    [async () => new Response("{}", { status: 429 }), "rate_limited"],
    [async () => new Response("<html>", { status: 502 }), "error"],
    [(s) => new Promise<Response>((_, rej) => s?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), "timeout"],
  ];
  for (const [fn, reason] of cases) {
    resetIntelligenceStateForTests(); respond = fn;
    const o = await place();
    const r = row(o.id), fc = (r.trustSnapshot as any).fraudCheck;
    assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired, fc.status, fc.reason, fc.source], [null, 200, true, "unavailable", reason, "fallback"], reason);
  }
});

test("without the Steadfast credentials (or with the courier switched off) checkout uses the fallback and makes no network call", async () => {
  delete process.env.STEADFAST_API_SECRET;
  const a = await place();
  process.env.STEADFAST_API_SECRET = SECRET; process.env.STEADFAST_ENABLED = "false";
  const b = await place();
  delete process.env.STEADFAST_ENABLED;
  for (const o of [a, b]) assert.deepEqual([(row(o.id).trustSnapshot as any).fraudCheck.reason, Number(row(o.id).advanceRequired), row(o.id).trustScore], ["no_provider", 200, null]);
  assert.equal(calls.length, 0);
});

test("no FRAUD_CHECK_PROVIDER variable is needed any more, and FRAUD_CHECK_PROVIDER=none switches the lookup off", async () => {
  await place();
  assert.equal(calls.length, 1);
  process.env.FRAUD_CHECK_PROVIDER = "none";
  const o = await place();
  assert.equal(calls.length, 1);
  assert.equal((row(o.id).trustSnapshot as any).fraudCheck.reason, "disabled");
});

test("the admin panel shows the Steadfast evidence and phone; a recheck calls the endpoint again and keeps the old result; customers never see any of it", async () => {
  const o = await place();
  const panel = (await getAdvancePanel(o.id))!;
  assert.deepEqual([panel.phone, panel.trust!.fraudCheck!.provider, panel.trust!.fraudCheck!.delivered, panel.trust!.fraudCheck!.cancelled], [PHONE, "steadfast", 9, 15]);
  assert.equal(panel.trust!.courier!.state, "rated");
  assert.ok(!JSON.stringify(panel).includes(KEY) && !JSON.stringify(panel).includes(SECRET));

  respond = async () => Response.json({ ...DOCUMENTED, total_parcels: 30, total_delivered: 9, total_cancelled: 21 });
  calls = [];
  const res = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: new Date(Date.now() + 120_000) });
  assert.deepEqual([calls.length, res.status, res.source, res.score], [1, "ok", "provider", 30]);          // 9 / 30 = 30%
  assert.equal((row(o.id).trustSnapshot as any).recheck.cancelled, 21);
  assert.equal((row(o.id).trustSnapshot as any).fraudCheck.cancelled, 15);                                  // the order-time evidence is kept

  const mine = JSON.stringify(await runAs(null, () => getOrderByNumberForCurrentUser(row(o.id).orderNumber as string)));
  assert.equal(mine.includes("fraudCheck") || mine.includes("trustScore") || mine.includes("trustSnapshot") || mine.includes("courier-rate-v2"), false);
});

test("the provider is 'connected' only after a real lookup succeeded: credentials alone are 'configured, not yet verified'", async () => {
  const env = { STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET };
  const state = async () => (await getIntelligenceProviderStatuses(env)).find((p) => p.key === "steadfast")!.state;
  assert.equal(await state(), "configured_unverified");
  respond = async () => new Response("{}", { status: 401 });
  await place();
  assert.equal(await state(), "error");
  respond = async () => Response.json(DOCUMENTED);
  await new Promise((r) => setTimeout(r, 5));
  await place();
  assert.equal(await state(), "connected");
});
