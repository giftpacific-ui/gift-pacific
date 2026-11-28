/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { discardAfter, drainAfter, emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { processCheckout } from "@/server/services/checkout-flow.service";
import { addRiskListEntry } from "@/server/services/risk-list.service";
import { findCheckoutReplay, IDEMPOTENCY_WINDOW_MS } from "@/server/services/checkout-guard.service";
import { CHECKOUT_KEY_PATTERN } from "@/lib/checkout-key";
import { normalizeBdPhone } from "@/lib/fraud/identity";
import type { CheckoutInput } from "@/lib/validations/checkout";

const realEnv = { ...process.env };
let db: FakeDb;
let seq = 0;
const errorLogs: unknown[][] = [];
const realConsoleError = console.error;
const KEY = (n: number | string) => `checkout-key-${String(n).padStart(8, "0")}`;

beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("product", "p-standard", { stock: 1000 });
  process.env.RATE_LIMIT_ENABLED = "false"; delete process.env.META_CONVERSIONS_API_TOKEN; delete process.env.GA4_API_SECRET;
  (globalThis as any).__TEST_COOKIES__.clear(); (globalThis as any).__TEST_HEADERS__ = {};
  errorLogs.length = 0; console.error = (...a: unknown[]) => { errorLogs.push(a); }; discardAfter();
});
afterEach(() => { console.error = realConsoleError; process.env = { ...realEnv }; discardAfter(); assert.deepEqual(errorLogs, [], "no server error may be logged during a test"); });

const data = (over: Partial<Record<string, unknown>> = {}): CheckoutInput =>
  ({ ...emptyCheckout, couponCode: "", rewardId: "", checkoutKey: KEY(1), ...over }) as unknown as CheckoutInput;
const fill = (user: string, qty = 1) => runAs({ sub: user }, () => addItemToCart({ productId: "p-standard", variantId: null, quantity: qty }));
const submit = (user: string, input: CheckoutInput) => runAs({ sub: user }, () => processCheckout(input));
const orders = () => db.rows("order").filter((o) => o.channelId === "channel_website");
const cookieOrder = () => (globalThis as any).__TEST_COOKIES__.get("gp_order_confirmation")?.value as string | undefined;

// ================================================================================================ idempotency
test("a repeated submission (double click / retry after a lost response) returns the SAME order and creates no second one", async () => {
  await fill("cust");
  const first = await submit("cust", data());
  assert.equal(first.success, true);
  const again = await submit("cust", data());
  const third = await submit("cust", data());
  assert.deepEqual(again, first);
  assert.deepEqual(third, first);
  assert.equal(orders().length, 1);
  assert.equal(db.get("product", "p-standard").stock, 999, "stock taken once");
  assert.ok(db.rows("orderRiskAssessment").length >= 1);
});

test("CONCURRENT submissions with the same key create exactly ONE order; every request gets that order's number", async () => {
  await fill("cust");
  const results = await Promise.all([submit("cust", data()), submit("cust", data()), submit("cust", data()), submit("cust", data())]);
  assert.ok(results.every((r) => r.success), JSON.stringify(results));
  assert.equal(new Set(results.map((r) => (r as any).orderNumber)).size, 1);
  assert.equal(orders().length, 1);
  assert.equal(db.get("product", "p-standard").stock, 999);
  assert.equal(errorLogs.length, 0);
});

test("two real, separate orders (different keys) are NEVER merged, even from the same customer with the same cart", async () => {
  await fill("cust");
  const a = await submit("cust", data({ checkoutKey: KEY("a") }));
  await fill("cust");
  const b = await submit("cust", data({ checkoutKey: KEY("b") }));
  assert.equal(a.success && b.success, true);
  assert.notEqual((a as any).orderNumber, (b as any).orderNumber);
  assert.equal(orders().length, 2);
});

test("concurrent checkouts by DIFFERENT customers are all accepted independently", async () => {
  for (const u of ["c1", "c2", "c3"]) await fill(u);
  const rs = await Promise.all(["c1", "c2", "c3"].map((u, i) => submit(u, data({ checkoutKey: KEY(i), phone: `+88017110000${i}0`, shippingAddress: { ...emptyCheckout.shippingAddress, phone: `+88017110000${i}0` }, email: `c${i}@example.com` }))));
  assert.ok(rs.every((r) => r.success));
  assert.equal(new Set(rs.map((r) => (r as any).orderNumber)).size, 3);
  assert.equal(orders().length, 3);
});

test("a key never hands over someone else's order: another account, another phone, or an old key is refused and creates nothing", async () => {
  await fill("cust");
  const first = (await submit("cust", data())) as any;
  const before = orders().length;
  for (const [user, input] of [["intruder", data()], ["cust", data({ phone: "+8801999999999" })]] as const) {
    await fill(user);
    const r = await submit(user, input);
    assert.deepEqual([r.success, (r as any).message], [false, "This checkout was already submitted. Please check your orders, or start a new checkout."], user);
  }
  assert.equal(orders().length, before, "no new order from a mismatched key");
  // Old key (beyond the window) is not a replay either.
  const row = orders()[0];
  db.patch("order", row.id as string, { createdAt: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS - 1000) });
  const old = await findCheckoutReplay(KEY(1), { userId: "cust", phone: "+8801711000000" });
  assert.deepEqual(old, { kind: "mismatch" });
  assert.ok(first.orderNumber);
});

test("a key is not 'used up' by a failed attempt: if nothing was created (e.g. empty cart), retrying with the same key places the order", async () => {
  const empty = await submit("cust", data());
  assert.equal(empty.success, false);
  assert.equal(orders().length, 0);
  await fill("cust");
  const ok = await submit("cust", data());
  assert.equal(ok.success, true);
  assert.equal(orders().length, 1);
});

test("the checkout key must have the agreed shape (random, 16-64 URL-safe characters); anything else is rejected, not trusted", () => {
  for (const good of [crypto.randomUUID(), "abcdefghijklmnop", "A_b-C_d-E_f-G_h-1234567890"]) assert.match(good, CHECKOUT_KEY_PATTERN);
  for (const bad of ["", "short", "has space in it 123456", "x".repeat(65), "bad/chars/in/key/12345", "'; DROP TABLE x;--aaaa", "ключ-ключ-ключ-ключ-ключ"]) assert.doesNotMatch(bad, CHECKOUT_KEY_PATTERN, bad);
});

// ================================================================================================ rate limiting
test("rate limit per phone: the 7th attempt in ten minutes is refused with a friendly message; replays of a SUCCESSFUL checkout are never counted", async () => {
  delete process.env.RATE_LIMIT_ENABLED;
  for (let i = 1; i <= 6; i++) {
    const r = await submit("cust", data({ checkoutKey: KEY(i) })); // empty cart: fails inside placeOrder, but each attempt counts
    assert.equal(r.success, false);
    assert.doesNotMatch((r as any).message, /too many/i, `attempt ${i}`);
  }
  const blocked = await submit("cust", data({ checkoutKey: KEY(7) }));
  assert.equal(blocked.success, false);
  assert.match((blocked as any).message, /try again|too many|wait/i);

  // A different customer (different phone) is unaffected.
  await fill("other");
  const ok = await submit("other", data({ checkoutKey: KEY(50), phone: "+8801811000000", shippingAddress: { ...emptyCheckout.shippingAddress, phone: "+8801811000000" }, email: "o@example.com" }));
  assert.equal(ok.success, true);
  // Replays of that success cost nothing.
  for (let i = 0; i < 12; i++) assert.equal((await submit("other", data({ checkoutKey: KEY(50), phone: "+8801811000000", shippingAddress: { ...emptyCheckout.shippingAddress, phone: "+8801811000000" }, email: "o@example.com" }))).success, true);
});

test("rate limit per IP is generous (shared networks) and is skipped entirely when no address is known", async () => {
  delete process.env.RATE_LIMIT_ENABLED;
  (globalThis as any).__TEST_HEADERS__ = { "x-forwarded-for": "198.51.100.20" };
  let lastMessage = "";
  for (let i = 1; i <= 21; i++) {
    const phone = `+88018${String(1000000 + i).slice(-7)}0`.slice(0, 14);
    const r = await submit("cust", data({ checkoutKey: KEY(i), phone, shippingAddress: { ...emptyCheckout.shippingAddress, phone }, email: `x${i}@example.com` }));
    lastMessage = (r as any).message ?? "";
  }
  assert.match(lastMessage, /try again|too many|wait/i, "the 21st attempt from one IP is throttled");
  (globalThis as any).__TEST_HEADERS__ = {};
  for (let i = 100; i <= 125; i++) {
    const phone = `+88017${String(2000000 + i).slice(-7)}0`.slice(0, 14);
    const r = await submit("cust", data({ checkoutKey: KEY(i), phone, shippingAddress: { ...emptyCheckout.shippingAddress, phone }, email: `y${i}@example.com` }));
    assert.doesNotMatch((r as any).message ?? "", /try again|too many|wait/i, `no-IP attempt ${i}`);
  }
});

// ================================================================================================ blocks at checkout
test("default (HOLD): a blocked phone is ACCEPTED and held for manual review as CRITICAL; nothing is refused or cancelled", async () => {
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "refused 3 parcels", adminId: "a1" });
  await fill("cust");
  const r = await submit("cust", data());
  assert.equal(r.success, true);
  const o = orders()[0];
  assert.deepEqual([o.status, o.riskLevel, o.riskReviewRequired], ["PENDING", "CRITICAL", true]);
  await assert.rejects(adminUpdateOrderStatus(o.id as string, "CONFIRMED" as never, undefined, TEST_ADMIN), /on hold for fraud review/);
});

test("REJECT mode: a blocked phone/e-mail is refused with a generic message that reveals nothing; the cart is kept; IP blocks and ADVISORY mode never reject", async () => {
  db.patch("storeSettings", "singleton", { fraudPolicy: { blockAction: "REJECT" } });
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "refused 3 parcels", adminId: "a1" });
  await fill("cust");
  const r = (await submit("cust", data())) as any;
  assert.equal(r.success, false);
  assert.equal(r.message, "We could not process this order online. Please contact us to complete it.");
  assert.doesNotMatch(r.message, /block|fraud|risk|list|banned/i);
  assert.equal(orders().length, 0);
  assert.equal((db.rows("cartItem") as any[]).length > 0, true, "the cart is untouched");
  // e-mail block
  await addRiskListEntry({ listType: "BLOCK", kind: "EMAIL", value: "bad@example.com", reason: "chargebacks", adminId: "a1" });
  await fill("u2");
  const e = (await submit("u2", data({ checkoutKey: KEY(2), phone: "+8801811111111", shippingAddress: { ...emptyCheckout.shippingAddress, phone: "+8801811111111" }, email: "Bad@Example.com" }))) as any;
  assert.equal(e.success, false);
  // IP-only block: never rejected, only held (HIGH).
  await addRiskListEntry({ listType: "BLOCK", kind: "IP", value: "203.0.113.50", reason: "card testing", expiresAt: new Date(Date.now() + 86_400_000), adminId: "a1" });
  (globalThis as any).__TEST_HEADERS__ = { "x-forwarded-for": "203.0.113.50" };
  await fill("u3");
  const ipOnly = await submit("u3", data({ checkoutKey: KEY(3), phone: "+8801822222222", shippingAddress: { ...emptyCheckout.shippingAddress, phone: "+8801822222222" }, email: "ok@example.com" }));
  assert.equal(ipOnly.success, true);
  assert.equal(orders()[0].riskLevel, "HIGH");
  // ADVISORY: accepted even with the phone blocked.
  db.patch("storeSettings", "singleton", { fraudPolicy: { blockAction: "REJECT", mode: "ADVISORY" } });
  (globalThis as any).__TEST_HEADERS__ = {};
  await fill("u4");
  assert.equal((await submit("u4", data({ checkoutKey: KEY(4) }))).success, true);
});

// ================================================================================================ the server decides the score
test("a client can NOT set its own risk: extra fields in the submission are ignored; the order is scored from server data only, with the IP the server saw", async () => {
  for (let i = 0; i < 3; i++) db.insert("order", { id: `h${i}`, orderNumber: `GP-H${i}`, channelId: "channel_website", status: "FAILED_DELIVERY", phone: "01711000000", phoneNorm: "01711000000", total: 100, createdAt: new Date(Date.now() - 86_400_000 * 10), shippingSnapshot: {}, riskReviewRequired: false });
  for (let i = 0; i < 3; i++) db.insert("orderTrackingEvent", { id: `he${i}`, orderId: `h${i}`, status: "FAILED_DELIVERY", createdAt: new Date() });
  for (let i = 3; i < 6; i++) db.insert("order", { id: `h${i}`, orderNumber: `GP-H${i}`, channelId: "channel_website", status: "CANCELLED", phone: "01711000000", phoneNorm: "01711000000", total: 100, createdAt: new Date(Date.now() - 86_400_000 * 10), shippingSnapshot: {}, riskReviewRequired: false });
  (globalThis as any).__TEST_HEADERS__ = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
  await fill("cust");
  const forged = data({ riskScore: 0, riskLevel: "LOW", riskReviewRequired: false, riskReviewDecision: "APPROVED", riskReviewedLevel: "CRITICAL", phoneNorm: "x", checkoutKey: KEY(9) }) as any;
  const r = await submit("cust", forged);
  assert.equal(r.success, true);
  const o = orders().find((x) => !String(x.id).startsWith("h"))!;
  assert.deepEqual([o.riskLevel, o.riskReviewRequired, o.riskReviewDecision, o.phoneNorm], ["HIGH", true, null, "01711000000"]);
  assert.equal(db.rows("orderRiskAssessment").find((a) => a.orderId === o.id)!.clientIp, "203.0.113.9");
});

test("a failing risk evaluation can never fail or delay the checkout; the order is then assessed when an admin confirms it", async () => {
  await fill("cust");
  const real = (globalThis as any).__TEST_DB__;
  (globalThis as any).__TEST_DB__ = new Proxy(real, { get(t, k) { const v = Reflect.get(t, k, t); return k === "orderRiskAssessment" ? { ...v, create: async () => { throw new Error("db down"); } } : v; } });
  let result: any;
  try { result = await submit("cust", data()); } finally { (globalThis as any).__TEST_DB__ = real; }
  assert.equal(result.success, true);
  assert.equal(orders().length, 1);
  assert.equal(orders()[0].riskScore, null);
  errorLogs.length = 0; // the swallowed failure is the point of this test
  await adminUpdateOrderStatus(orders()[0].id as string, "CONFIRMED" as never, undefined, TEST_ADMIN);
  await drainAfter();
  assert.equal(db.get("order", orders()[0].id as string).status, "CONFIRMED");
  assert.equal(db.get("order", orders()[0].id as string).riskLevel, "LOW", "assessed at confirmation time");
});

// ================================================================================================ repeated / duplicate orders
test("the same cart ordered twice within minutes (different submissions) creates two orders; the second is FLAGGED as a duplicate, not merged or cancelled", async () => {
  await fill("cust");
  await submit("cust", data({ checkoutKey: KEY("d1") }));
  await fill("cust");
  await submit("cust", data({ checkoutKey: KEY("d2") }));
  const [first, second] = orders().sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber)));
  assert.equal(orders().length, 2);
  assert.ok(orders().every((o) => o.status === "PENDING"));
  const sig = (id: string) => ((db.rows("orderRiskAssessment").filter((a) => a.orderId === id).at(-1)!.signals as any).signals as any[]).map((s) => s.code);
  assert.ok(sig(second.id as string).includes("DUPLICATE_CART") || sig(first.id as string).includes("DUPLICATE_CART"));
});

test("many orders from one phone in a short time raise the frequency signal progressively", async () => {
  const burst: number[] = [];
  for (let i = 1; i <= 5; i++) {
    await fill("cust");
    await submit("cust", data({ checkoutKey: KEY(`b${i}`) }));
    const o = orders().at(-1)!;
    const sigs = ((db.rows("orderRiskAssessment").filter((a) => a.orderId === o.id).at(-1)!.signals as any).signals as any[]);
    burst.push(sigs.find((s) => s.code === "PHONE_BURST")?.points ?? 0);
  }
  assert.deepEqual(burst, [0, 0, 6, 12, 18]);
});

test("phone normalisation at checkout: the stored key is the same whatever way the customer typed the number", async () => {
  for (const [i, phone] of ["01711000000", "+8801711000000", "8801711000000", "+880 1711-000000"].entries()) {
    await fill(`u${i}`);
    const r = await submit(`u${i}`, data({ checkoutKey: KEY(`p${i}`), phone, shippingAddress: { ...emptyCheckout.shippingAddress, phone }, email: `p${i}@example.com` }));
    assert.equal(r.success, true, phone);
  }
  assert.deepEqual([...new Set(orders().map((o) => o.phoneNorm))], [normalizeBdPhone("01711000000")]);
});
