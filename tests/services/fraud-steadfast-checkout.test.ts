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
import { resetFraudCheckStateForTests, setFraudCheckProviderForTests, setPhoneVerifiedForTests } from "@/server/services/fraud-check.service";

/**
 * Checkout and admin recheck with the REAL Steadfast fraud adapter and registry; only `fetch` is replaced (test-only). Response examples come from
 * tests/fixtures/steadfast-fraud-check (third-party descriptions, not the official guide: see the README there). Proves OUR rules; the live Steadfast
 * service has never been called.
 */
const COUNTS = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/steadfast-fraud-check/counts-and-ratios.json"), "utf8"));
const RATIOS_ONLY = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/steadfast-fraud-check/ratios-only.json"), "utf8"));
const KEY = "sf-key-CHECKOUT-123";
const SECRET = "sf-secret-CHECKOUT-456";
const PHONE = "01712345678";
const ENV = ["FRAUD_CHECK_PROVIDER", "FRAUD_CHECK_ENABLED", "FRAUD_CHECK_CACHE_SECONDS", "STEADFAST_API_KEY", "STEADFAST_API_SECRET", "STEADFAST_API_BASE_URL", "RATE_LIMIT_ENABLED"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let db: FakeDb;
let calls: { url: string; headers: any }[] = [];
let respond: () => Promise<Response> = async () => Response.json(COUNTS);

const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };

beforeEach(async () => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { FRAUD_CHECK_PROVIDER: "steadfast", FRAUD_CHECK_ENABLED: "true", FRAUD_CHECK_CACHE_SECONDS: "0", STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, RATE_LIMIT_ENABLED: "false" });
  calls = []; respond = async () => Response.json(COUNTS);
  globalThis.fetch = (async (url: string, init: any) => { calls.push({ url: String(url), headers: init.headers }); return respond(); }) as never;
  setFraudCheckProviderForTests(undefined);                // the REAL registry
  setPhoneVerifiedForTests(undefined);                     // the REAL default: no phone is verified
  resetFraudCheckStateForTests();
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("product", "p-standard", { stock: 100 });
  await saveAdvanceSettings(policy as never, "a1");
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch; setFraudCheckProviderForTests(undefined); setPhoneVerifiedForTests(undefined); resetFraudCheckStateForTests();
});

let n = 0;
const place = (phone = PHONE) => runAs(null, async () => {
  await addItemToCart({ productId: "p-standard", quantity: 1 });
  return placeOrder({ ...emptyCheckout, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXSTEAD${String(++n).padStart(5, "0")}` } as never);
});
const row = (id: string) => db.get("order", id);

test("checkout calls the Steadfast endpoint with the courier credentials and stores the evidence; delivered earns nothing, cancellations lower trust, the advance stays standard", async () => {
  const o = await place();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://portal.packzy.com/api/v1/fraud_check/score/${PHONE}`);
  assert.deepEqual([calls[0].headers["Api-Key"], calls[0].headers["Secret-Key"]], [KEY, SECRET]);
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [0, 200, true]);               // 50 - 5*20, clamped; 58 delivered parcels credit nothing
  const fc = (r.trustSnapshot as any).fraudCheck;
  assert.deepEqual([fc.status, fc.source, fc.provider, fc.delivered, fc.cancelled, fc.returned, fc.total, fc.phoneVerified], ["ok", "provider", "steadfast", 58, 5, null, 63, false]);
  const text = JSON.stringify(r.trustSnapshot);
  for (const secret of [KEY, SECRET, PHONE, "1712345678"]) assert.ok(!text.includes(secret), `snapshot leaked ${secret}`);
  assert.equal(fc.phoneLast4, "5678");
});

test("an answer without counts, a rejected key, and a provider outage all fall back to the standard advance and never block the order", async () => {
  for (const [fn, reason] of [
    [async () => Response.json(RATIOS_ONLY), "no_counts"],
    [async () => new Response("{}", { status: 401 }), "auth_failed"],
    [async () => new Response("{}", { status: 429 }), "rate_limited"],
    [async () => new Response("<html>", { status: 502 }), "error"],
  ] as [() => Promise<Response>, string][]) {
    resetFraudCheckStateForTests(); respond = fn;
    const o = await place();
    const r = row(o.id), fc = (r.trustSnapshot as any).fraudCheck;
    assert.deepEqual([r.trustScore, Number(r.advanceRequired), fc.status, fc.reason, fc.source], [50, 200, "unavailable", reason, "fallback"], reason);
  }
});

test("without the Steadfast credentials (or with the courier switched off) checkout uses the fallback and makes no network call", async () => {
  delete process.env.STEADFAST_API_SECRET;
  const a = await place();
  process.env.STEADFAST_API_SECRET = SECRET; process.env.STEADFAST_ENABLED = "false";
  const b = await place();
  delete process.env.STEADFAST_ENABLED;
  for (const o of [a, b]) assert.deepEqual([(row(o.id).trustSnapshot as any).fraudCheck.reason, Number(row(o.id).advanceRequired)], ["no_provider", 200]);
  assert.equal(calls.length, 0);
});

test("the admin panel shows the Steadfast evidence and phone; a recheck calls the endpoint again; customers never see any of it", async () => {
  const o = await place();
  const panel = (await getAdvancePanel(o.id))!;
  assert.deepEqual([panel.phone, panel.trust!.fraudCheck!.provider, panel.trust!.fraudCheck!.delivered, panel.trust!.fraudCheck!.cancelled], [PHONE, "steadfast", 58, 5]);
  assert.ok(!JSON.stringify(panel).includes(KEY) && !JSON.stringify(panel).includes(SECRET));

  respond = async () => Response.json({ ...COUNTS, delivered_count: 60, cancelled_count: 6 });
  calls = [];
  const res = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: new Date(Date.now() + 120_000) });
  assert.deepEqual([calls.length, res.status, res.source, res.score], [1, "ok", "provider", 0]);
  assert.equal((row(o.id).trustSnapshot as any).recheck.cancelled, 6);
  assert.equal((row(o.id).trustSnapshot as any).fraudCheck.cancelled, 5);                                            // the order-time evidence is kept

  const mine = JSON.stringify(await runAs(null, () => getOrderByNumberForCurrentUser(row(o.id).orderNumber as string)));
  assert.equal(mine.includes("fraudCheck") || mine.includes("trustScore") || mine.includes("trustSnapshot"), false);
});
