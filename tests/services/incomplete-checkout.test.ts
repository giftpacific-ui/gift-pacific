/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { processCheckout } from "@/server/services/checkout-flow.service";
import {
  adminGetIncompleteCheckout, adminListIncompleteCheckouts, adminRunIncompleteCheckoutCleanup, cleanupIncompleteCheckouts,
  discardCheckoutProgress, saveCheckoutProgress,
} from "@/server/services/incomplete-checkout.service";
import { recoveryConfig } from "@/lib/checkout-recovery";
import type { CheckoutInput } from "@/lib/validations/checkout";

const realEnv = { ...process.env };
let db: FakeDb;
beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("product", "p-standard", { stock: 1000 });
  process.env.RATE_LIMIT_ENABLED = "false"; process.env.AUTH_SECRET = "test-secret";
  (globalThis as any).__TEST_COOKIES__.clear(); (globalThis as any).__TEST_HEADERS__ = {}; discardAfter();
});
afterEach(() => { process.env = { ...realEnv }; discardAfter(); });

const KEY = (n: number) => `checkout-key-${String(n).padStart(8, "0")}`;
const progress = (over: Record<string, unknown> = {}) => ({
  consent: true, email: "Buyer@Example.com", phone: "01711000000", deliveryZone: "DHAKA_CITY", checkoutKey: KEY(1),
  shippingAddress: { fullName: "Buyer One", line1: "House 1", city: "Dhaka", country: "Bangladesh" }, ...over,
});
const guest = <T,>(token: string, fn: () => Promise<T>) => runAs(null, fn, { guest: token });
const customer = <T,>(id: string, fn: () => Promise<T>, token?: string) => runAs({ sub: id }, fn, { guest: token });
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const addStandard = (qty = 2) => addItemToCart({ productId: "p-standard", variantId: null, quantity: qty });
const rows = () => db.rows("incompleteCheckout");

// ================================================================================================ autosave
test("autosave stores contact, delivery, server-priced cart, estimate and timestamps for a guest, and creates NO account", () => guest("A", async () => {
  await addStandard(2);
  const r = await saveCheckoutProgress(progress());
  assert.deepEqual(r, { saved: true });
  const [rec] = rows();
  assert.equal(rec.status, "ACTIVE");
  assert.equal(rec.email, "buyer@example.com");
  assert.equal(rec.phone, "01711000000");
  assert.equal(rec.customerName, "Buyer One");
  assert.equal(rec.userId, null);
  assert.equal(rec.deliveryZone, "DHAKA_CITY");
  assert.equal(rec.itemCount, 2);
  assert.equal(rec.subtotal, 3600); // server price 1800 x 2
  assert.equal(rec.estimatedTotal, 3670); // + Dhaka delivery 70
  assert.deepEqual(rec.items.map((l: any) => [l.productId, l.quantity, l.unitPrice]), [["p-standard", 2, 1800]]);
  assert.ok(rec.consentAt instanceof Date && rec.lastActivityAt instanceof Date && rec.createdAt instanceof Date);
  assert.ok(!String(rec.ownerKey).includes("A") || rec.ownerKey.startsWith("g:"), "raw cookie is not stored");
  assert.notEqual(rec.ownerKey, "g:A");
  assert.equal(db.rows("user").filter((u) => u.role !== "ADMIN").length, 0, "no customer account was created for the guest");
}));

test("nothing is saved without consent, without a valid contact, without a cart, or when the feature is off", () => guest("A", async () => {
  await addStandard(1);
  assert.equal((await saveCheckoutProgress(progress({ consent: false }))).reason, "no_consent");
  assert.equal((await saveCheckoutProgress({ ...progress(), consent: undefined })).reason, "no_consent");
  assert.equal((await saveCheckoutProgress(progress({ email: "", phone: "" }))).reason, "insufficient");
  assert.equal((await saveCheckoutProgress(progress({ email: "not-an-email", phone: "12345" }))).reason, "insufficient");
  assert.equal((await saveCheckoutProgress(progress(), { enabled: false, expiryDays: 30, purgeDays: 60 })).reason, "disabled");
  assert.equal(rows().length, 0);
  // a visitor without any cart (no cookie row) saves nothing and no cart is created for them
  assert.equal((await guest("nobody", () => saveCheckoutProgress(progress()))).reason, "no_cart");
  assert.equal(db.rows("cart").length, 1);
  assert.equal(rows().length, 0);
}));

test("a valid e-mail OR a valid phone alone is sufficient", () => guest("A", async () => {
  await addStandard(1);
  assert.equal((await saveCheckoutProgress(progress({ phone: "" }))).saved, true);
  assert.equal(rows()[0].phone, null);
  assert.equal(rows()[0].email, "buyer@example.com");
  assert.equal((await saveCheckoutProgress(progress({ email: "garbage" }))).saved, true);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].email, null, "an invalid e-mail is never stored");
  assert.equal(rows()[0].phone, "01711000000");
}));

test("sensitive or unknown fields are rejected outright and never stored", () => guest("A", async () => {
  await addStandard(1);
  for (const extra of [{ password: "hunter2" }, { otp: "123456" }, { cardNumber: "4111111111111111" }, { advanceReference: "TX123456" }, { customerNote: "note" }, { billingAddress: {} }]) {
    const r = await saveCheckoutProgress({ ...progress(), ...extra });
    assert.equal(r.saved, false);
    assert.equal(r.reason, "invalid");
  }
  const r = await saveCheckoutProgress({ ...progress(), shippingAddress: { fullName: "X Y", cvv: "123" } });
  assert.equal(r.reason, "invalid");
  assert.equal(rows().length, 0);
  assert.equal((await saveCheckoutProgress(progress({ email: "a".repeat(300) + "@x.com" }))).reason, "invalid");
  // what IS stored holds only the whitelisted columns
  await saveCheckoutProgress(progress());
  assert.doesNotMatch(JSON.stringify(rows()), /password|otp|card|cvv|advanceReference|customerNote/i);
}));

test("the cart snapshot comes from the server cart: forged prices/quantities from the browser are ignored (and rejected)", () => guest("A", async () => {
  await addStandard(1);
  assert.equal((await saveCheckoutProgress({ ...progress(), items: [{ productId: "p-standard", quantity: 99, unitPrice: 1 }], subtotal: 1 })).reason, "invalid");
  await saveCheckoutProgress(progress());
  assert.equal(rows()[0].subtotal, 1800);
}));

test("an empty cart removes the visitor's open record; a late autosave cannot resurrect an already-placed checkout", () => guest("A", async () => {
  await addStandard(1);
  await saveCheckoutProgress(progress());
  assert.equal(rows().length, 1);
  await db.cartItem.deleteMany({ where: {} });
  assert.equal((await saveCheckoutProgress(progress())).reason, "empty_cart");
  assert.equal(rows().length, 0);
  await addStandard(1);
  const placed = await processCheckout({ ...emptyCheckout, couponCode: "", rewardId: "", checkoutKey: KEY(7) } as unknown as CheckoutInput);
  assert.equal(placed.success, true);
  await addStandard(1); // cart refilled; a delayed save from the placed attempt arrives
  assert.equal((await saveCheckoutProgress(progress({ checkoutKey: KEY(7) }))).reason, "already_ordered");
  assert.equal(rows().filter((r) => r.status === "ACTIVE").length, 0);
}));

// ================================================================================================ deduplication / customers
test("repeated and concurrent saves keep ONE open record per visitor and update it as checkout progresses", () => guest("A", async () => {
  await addStandard(1);
  await saveCheckoutProgress(progress({ phone: "" }));
  const first = rows()[0];
  await new Promise((r) => setTimeout(r, 5));
  await saveCheckoutProgress(progress({ deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { fullName: "Buyer One", line1: "House 9", city: "Khulna", country: "Bangladesh" } }));
  assert.equal(rows().length, 1);
  const second = rows()[0];
  assert.equal(second.id, first.id);
  assert.equal(second.phone, "01711000000");
  assert.equal(second.deliveryZone, "OUTSIDE_DHAKA");
  assert.equal(second.estimatedTotal, 1900); // 1800 + 100
  assert.equal(second.shippingAddress.city, "Khulna");
  assert.ok(second.lastActivityAt > first.lastActivityAt);
  assert.equal(second.createdAt.getTime(), first.createdAt.getTime());
  await db.incompleteCheckout.deleteMany({ where: {} });
  const res = await Promise.all([1, 2, 3, 4, 5].map(() => saveCheckoutProgress(progress())));
  assert.ok(res.every((r) => r.saved), JSON.stringify(res));
  assert.equal(rows().filter((r) => r.status === "ACTIVE").length, 1);
}));

test("a signed-in customer's record is linked to them; their cart-less guest cookie does not create a second record", async () => {
  db.insert("user", { id: "cust", email: "cust@example.com", name: "Cust", role: "CUSTOMER" });
  await customer("cust", async () => {
    await addStandard(1);
    await saveCheckoutProgress(progress());
    await saveCheckoutProgress(progress({ deliveryZone: "OTHER" }));
  });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].userId, "cust");
  assert.equal(rows()[0].ownerKey, "u:cust");
});

test("a guest who signs in mid-checkout: the guest record becomes theirs (no duplicate)", async () => {
  db.insert("user", { id: "cust", email: "cust@example.com", name: "Cust", role: "CUSTOMER" });
  await guest("A", async () => { await addStandard(1); await saveCheckoutProgress(progress()); });
  assert.equal(rows().length, 1);
  await customer("cust", async () => { await addStandard(1); await saveCheckoutProgress(progress()); }, "A");
  const active = rows().filter((r) => r.status === "ACTIVE");
  assert.equal(active.length, 1);
  assert.equal(active[0].userId, "cust");
  assert.equal(active[0].ownerKey, "u:cust");
});

// ================================================================================================ conversion
test("placing the order marks the visitor's open record CONVERTED and links it to that order (guest and customer)", async () => {
  db.insert("user", { id: "cust", email: "cust@example.com", name: "Cust", role: "CUSTOMER" });
  const place = async (who: "guest" | "cust", n: number) => {
    const run = who === "guest" ? (fn: () => Promise<any>) => guest("A", fn) : (fn: () => Promise<any>) => customer("cust", fn);
    return run(async () => {
      await addStandard(1);
      await saveCheckoutProgress(progress({ checkoutKey: KEY(n) }));
      const res = await processCheckout({ ...emptyCheckout, couponCode: "", rewardId: "", checkoutKey: KEY(n) } as unknown as CheckoutInput);
      assert.equal(res.success, true, JSON.stringify(res));
      return res as { orderNumber: string };
    });
  };
  const g = await place("guest", 1);
  const c = await place("cust", 2);
  const recs = rows();
  assert.equal(recs.length, 2);
  for (const rec of recs) {
    assert.equal(rec.status, "CONVERTED");
    assert.ok(rec.convertedAt instanceof Date);
    const order = db.get("order", rec.orderId);
    assert.ok([g.orderNumber, c.orderNumber].includes(order.orderNumber));
    assert.equal(order.checkoutKey, rec.checkoutKey);
  }
  assert.equal(recs.filter((r) => r.status === "ACTIVE").length, 0);
  // a later checkout by the same guest gets a NEW open record; the converted one is untouched
  await guest("A", async () => { await addStandard(1); await saveCheckoutProgress(progress({ checkoutKey: KEY(3) })); });
  assert.equal(rows().length, 3);
  assert.equal(rows().filter((r) => r.status === "CONVERTED").length, 2);
});

test("a failed order leaves the record open; a record with no saved progress converts nothing", () => guest("A", async () => {
  await addStandard(1);
  await saveCheckoutProgress(progress({ checkoutKey: KEY(4) }));
  const bad = await processCheckout({ ...emptyCheckout, paymentMethod: "STRIPE", couponCode: "", rewardId: "", checkoutKey: KEY(4) } as unknown as CheckoutInput);
  assert.equal(bad.success, false);
  assert.equal(rows()[0].status, "ACTIVE");
  assert.equal(rows()[0].orderId, null);
  await db.incompleteCheckout.deleteMany({ where: {} });
  const ok = await processCheckout({ ...emptyCheckout, couponCode: "", rewardId: "", checkoutKey: KEY(5) } as unknown as CheckoutInput);
  assert.equal(ok.success, true);
  assert.equal(rows().length, 0);
}));

// ================================================================================================ guest isolation
test("one guest can never read, change, delete or convert another guest's record", async () => {
  await guest("A", async () => { await addStandard(1); await saveCheckoutProgress(progress({ email: "a@example.com", phone: "01711111111", checkoutKey: KEY(10) })); });
  await guest("B", async () => { await addStandard(3); await saveCheckoutProgress(progress({ email: "b@example.com", phone: "01722222222", checkoutKey: KEY(11) })); });
  const [a, b] = ["a@example.com", "b@example.com"].map((e) => rows().find((r) => r.email === e)!);
  assert.notEqual(a.ownerKey, b.ownerKey);
  // B's activity only ever touches B's row
  await guest("B", () => saveCheckoutProgress(progress({ email: "b2@example.com", phone: "01722222222", checkoutKey: KEY(11) })));
  assert.equal(db.get("incompleteCheckout", a.id).email, "a@example.com");
  assert.equal(db.get("incompleteCheckout", b.id).email, "b2@example.com");
  // B withdrawing deletes only B's record
  assert.deepEqual(await guest("B", () => discardCheckoutProgress()), { discarded: 1 });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].id, a.id);
  // B placing an order does not convert A's record
  await guest("B", async () => { await addStandard(1); await processCheckout({ ...emptyCheckout, couponCode: "", rewardId: "", checkoutKey: KEY(12) } as unknown as CheckoutInput); });
  assert.equal(db.get("incompleteCheckout", a.id).status, "ACTIVE");
  // a visitor with no cookie, and a customer, cannot touch it either
  assert.deepEqual(await runAs(null, () => discardCheckoutProgress()), { discarded: 0 });
  db.insert("user", { id: "cust", email: "c@example.com", name: "C", role: "CUSTOMER" });
  assert.deepEqual(await customer("cust", () => discardCheckoutProgress()), { discarded: 0 });
  assert.equal(db.get("incompleteCheckout", a.id).status, "ACTIVE");
  // the public save API returns no record id or stored data
  const res = await guest("A", () => saveCheckoutProgress(progress({ email: "a@example.com", phone: "01711111111", checkoutKey: KEY(10) })));
  assert.deepEqual(Object.keys(res), ["saved"]);
});

// ================================================================================================ authorization (admin)
test("admin list/detail/cleanup refuse guests and customers; an admin can use them", async () => {
  await guest("A", async () => { await addStandard(1); await saveCheckoutProgress(progress()); });
  const id = rows()[0].id;
  db.insert("user", { id: "cust", email: "c@example.com", name: "C", role: "CUSTOMER" });
  for (const who of [() => guest("A", (() => adminListIncompleteCheckouts()) as any), () => customer("cust", (() => adminListIncompleteCheckouts()) as any)]) {
    await assert.rejects(who(), /FORBIDDEN/);
  }
  await assert.rejects(guest("A", () => adminGetIncompleteCheckout(id)), /FORBIDDEN/);
  await assert.rejects(customer("cust", () => adminGetIncompleteCheckout(id)), /FORBIDDEN/);
  await assert.rejects(customer("cust", () => adminRunIncompleteCheckoutCleanup()), /FORBIDDEN/);
  const list = await admin(() => adminListIncompleteCheckouts());
  assert.equal(list.total, 1);
  assert.equal(list.items[0].kind, "guest");
  assert.equal(list.items[0].estimatedTotal, 1870);
  const detail = await admin(() => adminGetIncompleteCheckout(id));
  assert.equal(detail?.email, "buyer@example.com");
  assert.equal(detail?.lines[0].name, "Clay Vase");
  assert.equal(await admin(() => adminGetIncompleteCheckout("missing")), null);
  // the stored raw ownerKey (which identifies the guest cookie) is never part of the admin view
  assert.doesNotMatch(JSON.stringify(detail), /ownerKey|g:[0-9a-f]{20}/);
});

test("admin list: search by name/email/phone, filter by status and customer type, with paging", async () => {
  db.insert("user", { id: "cust", email: "c@example.com", name: "C", role: "CUSTOMER" });
  await guest("A", async () => { await addStandard(1); await saveCheckoutProgress(progress({ email: "alice@example.com", phone: "01711111111", shippingAddress: { fullName: "Alice Rahman", line1: "x road", city: "Dhaka", country: "Bangladesh" } })); });
  await guest("B", async () => { await addStandard(1); await saveCheckoutProgress(progress({ email: "bob@example.com", phone: "01722222222", shippingAddress: { fullName: "Bob Khan", line1: "y road", city: "Dhaka", country: "Bangladesh" } })); });
  await customer("cust", async () => { await addStandard(1); await saveCheckoutProgress(progress({ email: "carol@example.com", phone: "01733333333" })); });
  db.patch("incompleteCheckout", rows().find((r) => r.email === "bob@example.com")!.id, { status: "EXPIRED" });
  const q = (p: any) => admin(() => adminListIncompleteCheckouts(p));
  assert.equal((await q({})).total, 3);
  assert.deepEqual((await q({ q: "alice" })).items.map((i) => i.email), ["alice@example.com"]);
  assert.deepEqual((await q({ q: "ROBERTS" })).items, []);
  assert.deepEqual((await q({ q: "Bob Khan" })).items.map((i) => i.email), ["bob@example.com"]);
  assert.deepEqual((await q({ q: "+8801733333333" })).items.map((i) => i.email), ["carol@example.com"]);
  assert.deepEqual((await q({ status: "EXPIRED" })).items.map((i) => i.email), ["bob@example.com"]);
  assert.equal((await q({ status: "bogus" })).total, 3);
  assert.deepEqual((await q({ kind: "customer" })).items.map((i) => i.email), ["carol@example.com"]);
  assert.equal((await q({ kind: "guest" })).total, 2);
  const all = await q({ page: 1 });
  assert.deepEqual(all.counts, { ACTIVE: 2, CONVERTED: 0, EXPIRED: 1 });
  assert.equal(all.pageCount, 1);
});

// ================================================================================================ cleanup
const DAY = 86_400_000;
const seedRec = (over: Record<string, unknown>) => db.insert("incompleteCheckout", {
  ownerKey: `g:${Math.random()}`, status: "ACTIVE", email: "old@example.com", phone: "01711000000", phoneNorm: "01711000000", customerName: "Old", shippingAddress: { line1: "x" },
  couponCode: "C1", items: [], itemCount: 1, subtotal: 100, estimatedTotal: 170, consentAt: new Date(), lastActivityAt: new Date(), userId: null, orderId: null, ...over,
});

test("cleanup: idle open records expire and lose personal details; recent ones are kept; CONVERTED are never touched", async () => {
  const now = new Date("2026-12-01T00:00:00Z");
  const old = seedRec({ lastActivityAt: new Date(now.getTime() - 31 * DAY) });
  const recent = seedRec({ lastActivityAt: new Date(now.getTime() - 5 * DAY) });
  db.insert("order", { id: "o-1", orderNumber: "AP-X-1", phone: "01711000000", total: 100, subtotal: 100, shippingSnapshot: {} });
  const converted = seedRec({ status: "CONVERTED", orderId: "o-1", convertedAt: new Date(now.getTime() - 400 * DAY), lastActivityAt: new Date(now.getTime() - 400 * DAY) });
  const res = await cleanupIncompleteCheckouts({ now, config: { enabled: true, expiryDays: 30, purgeDays: 60 } });
  assert.deepEqual(res, { expired: 1, purged: 0 });
  const o = db.get("incompleteCheckout", old.id);
  assert.equal(o.status, "EXPIRED");
  assert.deepEqual([o.email, o.phone, o.phoneNorm, o.customerName, o.shippingAddress, o.couponCode], [null, null, null, null, null, null]);
  assert.equal(db.get("incompleteCheckout", recent.id).status, "ACTIVE");
  assert.equal(db.get("incompleteCheckout", recent.id).email, "old@example.com");
  const c = db.get("incompleteCheckout", converted.id);
  assert.equal(c.status, "CONVERTED");
  assert.equal(c.email, "old@example.com");
  assert.equal(c.orderId, "o-1");
});

test("cleanup: expired records are deleted only after the purge window and only when they never produced an order", async () => {
  const now = new Date("2027-03-01T00:00:00Z");
  const cfg = { enabled: true, expiryDays: 30, purgeDays: 60 };
  const freshlyExpired = seedRec({ status: "EXPIRED", expiredAt: new Date(now.getTime() - 10 * DAY), email: null });
  const longExpired = seedRec({ status: "EXPIRED", expiredAt: new Date(now.getTime() - 61 * DAY), email: null });
  db.insert("order", { id: "o-2", orderNumber: "AP-X-2", phone: "01711000000", total: 100, subtotal: 100, shippingSnapshot: {} });
  const linked = seedRec({ status: "EXPIRED", orderId: "o-2", expiredAt: new Date(now.getTime() - 300 * DAY), email: null });
  const converted = seedRec({ status: "CONVERTED", orderId: "o-3", convertedAt: new Date(now.getTime() - 900 * DAY), expiredAt: null });
  const res = await cleanupIncompleteCheckouts({ now, config: cfg });
  assert.deepEqual(res, { expired: 0, purged: 1 });
  const ids = rows().map((r) => r.id);
  assert.ok(ids.includes(freshlyExpired.id) && ids.includes(linked.id) && ids.includes(converted.id));
  assert.ok(!ids.includes(longExpired.id));
  assert.equal(await cleanupIncompleteCheckouts({ now, config: cfg }).then((r) => r.purged), 0, "idempotent");
});

test("cleanup configuration is read from the environment with safe bounds; admin cleanup uses it", async () => {
  assert.deepEqual(recoveryConfig({}), { enabled: true, expiryDays: 30, purgeDays: 60 });
  assert.deepEqual(recoveryConfig({ CHECKOUT_RECOVERY_ENABLED: "false", CHECKOUT_RECOVERY_EXPIRY_DAYS: "7", CHECKOUT_RECOVERY_PURGE_DAYS: "14" }), { enabled: false, expiryDays: 7, purgeDays: 14 });
  assert.deepEqual(recoveryConfig({ CHECKOUT_RECOVERY_EXPIRY_DAYS: "0", CHECKOUT_RECOVERY_PURGE_DAYS: "abc" }), { enabled: true, expiryDays: 30, purgeDays: 60 });
  assert.equal(recoveryConfig({ CHECKOUT_RECOVERY_EXPIRY_DAYS: "9999" }).expiryDays, 30);
  process.env.CHECKOUT_RECOVERY_EXPIRY_DAYS = "7";
  const rec = seedRec({ lastActivityAt: new Date(Date.now() - 8 * DAY) });
  assert.deepEqual(await admin(() => adminRunIncompleteCheckoutCleanup()), { expired: 1, purged: 0 });
  assert.equal(db.get("incompleteCheckout", rec.id).status, "EXPIRED");
});

// ================================================================================================ rate limiting
test("autosave is rate limited per visitor: over the limit saves are silently skipped", () => guest("A", async () => {
  process.env.RATE_LIMIT_ENABLED = "true";
  await addStandard(1);
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await saveCheckoutProgress(progress())).reason === "limited") limited++;
  assert.ok(limited >= 9 && limited <= 10, `limited=${limited}`);
  assert.equal(rows().length, 1);
  // another visitor is not affected
  await guest("B", async () => { await addStandard(1); assert.equal((await saveCheckoutProgress(progress({ email: "b@example.com" }))).saved, true); });
}));

test("no recovery e-mail or message exists in this feature (source check)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/server/services/incomplete-checkout.service.ts", "utf8");
  assert.doesNotMatch(src, /sendEmail|nodemailer|resend|sendMail|notification\.service|sms/i);
});
