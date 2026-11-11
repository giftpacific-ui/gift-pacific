import { reviewTrustOrder } from "@/server/services/advance.service";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, seedAdmins, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import {
  adminUpdateOrderStatus,
  placeOrder,
} from "@/server/services/order.service";
import {
  rejectAdvancePayment,
  saveAdvanceSettings,
  verifyAdvancePayment,
  waiveAdvance,
} from "@/server/services/advance.service";
import { checkBookingEligibility } from "@/lib/courier/status";

let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedCatalog(db);
  seedAdmins(db);
});
const policy = {
  enabled: true,
  zones: ["OUTSIDE_DHAKA"] as never,
  standardAmount: 200,
  reducedAmount: 100,
  zeroAtFullTrust: false,
  lowBelow: 60,
  reducedFrom: 80,
  fullAt: 100,
  instructions: "Send to bKash 01XXXXXXXXX",
};
const order = (user: string | null, extra: Record<string, unknown> = {}) =>
  runAs(user ? { sub: user } : null, async () => {
    await addItemToCart({ productId: "p-standard", quantity: 1 });
    return placeOrder({
      ...emptyCheckout,
      deliveryZone: "OUTSIDE_DHAKA",
      ...extra,
    } as never);
  });
const claim = { advanceMethod: "BKASH", advanceReference: "TX12345678" };
const admin = <T>(fn: () => Promise<T>) => runAs("admin", fn);

test("policy off or another zone: no advance, no Payment row, no gate", async () => {
  const o = await order("u1");
  assert.equal(Number(db.get("order", o.id).advanceRequired), 0);
  await saveAdvanceSettings(policy, "a1");
  const d = await runAs({ sub: "u1" }, async () => {
    await addItemToCart({ productId: "p-standard", quantity: 1 });
    return placeOrder({
      ...emptyCheckout,
      deliveryZone: "DHAKA_CITY",
    } as never);
  });
  assert.equal(Number(db.get("order", d.id).advanceRequired), 0);
  assert.equal(db.rows("payment").length, 0);
});

test("outside Dhaka: server decides the advance (standard for a new customer), keeps the customer's reference UNVERIFIED, and stores the explanation", async () => {
  await saveAdvanceSettings(policy, "a1");
  await assert.rejects(order("u1"), /advance of 200/); // claim missing
  await assert.rejects(
    order("u1", { advanceMethod: "BKASH", advanceReference: "x" }),
    /advance/,
  );
  assert.equal(db.rows("order").length, 0);
  const o = await order(null, claim); // guest → conservative default
  const row = db.get("order", o.id);
  assert.deepEqual(
    [
      Number(row.advanceRequired),
      Number(row.advancePaid),
      row.trustScore,
      row.paymentStatus,
    ],
    [200, 0, 50, "UNPAID"],
  );
  assert.ok(
    Array.isArray((row.trustSnapshot as { reasons: string[] }).reasons),
  );
  const pay = db.rows("payment")[0];
  assert.deepEqual(
    [
      pay.status,
      pay.kind,
      pay.customerReference,
      pay.providerRef ?? null,
      Number(pay.amount),
    ],
    ["PENDING", "ADVANCE", "TX12345678", null, 200],
  );
});

test("the order cannot be confirmed until the advance is VERIFIED; a partial advance is PARTIALLY_PAID, never PAID", async () => {
  await saveAdvanceSettings(policy, "a1");
  const o = await order(null, claim);
  await assert.rejects(
    admin(() => adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN)),
    /advance/,
  );
  const payId = db.rows("payment")[0].id as string;
  await admin(() =>
    verifyAdvancePayment({
      paymentId: payId,
      adminId: "a1",
      providerRef: "WALLET-TX-1",
      amount: 200,
    }),
  );
  const row = db.get("order", o.id);
  assert.deepEqual(
    [Number(row.advancePaid), row.paymentStatus],
    [200, "PARTIALLY_PAID"],
  );
  // A new customer scores 50 (< 60: low tier) so a recorded staff review is the SECOND gate, after the verified advance.
  await assert.rejects(
    admin(() => adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN)),
    /staff review/,
  );
  await reviewTrustOrder({
    orderId: o.id,
    adminId: "a1",
    note: "Called the customer, address confirmed",
  });
  await admin(() => adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN));
  // courier collects only the remaining balance
  const view = {
    status: "CONFIRMED",
    paymentMethod: "COD",
    paymentStatus: "PARTIALLY_PAID",
    total: Number(row.total),
    advancePaid: 200,
    courierBookingStatus: "NOT_BOOKED",
    courierBookingStartedAt: null,
    recipient: { name: "A B", phone: "01711000000", address: "Somewhere 12" },
  } as never;
  const el = checkBookingEligibility(view, new Date());
  assert.ok(el.ok && el.codAmount === Number(row.total) - 200);
});

test("duplicate/replayed verification: same payment twice and the same wallet transaction on another order are both refused", async () => {
  await saveAdvanceSettings(policy, "a1");
  const a = await order(null, claim);
  const b = await order(null, { ...claim, advanceReference: "TX99999999" });
  const [pa, pb] = db.rows("payment").map((p) => p.id as string);
  await verifyAdvancePayment({
    paymentId: pa,
    adminId: "a1",
    providerRef: "WALLET-TX-1",
    amount: 200,
  });
  await assert.rejects(
    verifyAdvancePayment({
      paymentId: pa,
      adminId: "a1",
      providerRef: "WALLET-TX-1",
      amount: 200,
    }),
    /already/,
  );
  await assert.rejects(
    verifyAdvancePayment({
      paymentId: pb,
      adminId: "a1",
      providerRef: "WALLET-TX-1",
      amount: 200,
    }),
    /already been used/,
  );
  assert.equal(Number(db.get("order", b.id).advancePaid), 0);
  assert.equal(Number(db.get("order", a.id).advancePaid), 200);
});

test("rejecting needs a reason; waiving needs a reason, is recorded with the actor, and unblocks confirmation", async () => {
  await saveAdvanceSettings(policy, "a1");
  const o = await order(null, claim);
  const payId = db.rows("payment")[0].id as string;
  await assert.rejects(
    rejectAdvancePayment({ paymentId: payId, adminId: "a1", reason: " " }),
  );
  await assert.rejects(
    waiveAdvance({ orderId: o.id, adminId: "a1", reason: "ok" }),
  );
  await waiveAdvance({
    orderId: o.id,
    adminId: "a1",
    reason: "Known repeat customer, phoned",
  });
  assert.deepEqual(
    [
      db.get("order", o.id).advanceWaivedById,
      db.get("order", o.id).advanceWaivedReason,
    ],
    ["a1", "Known repeat customer, phoned"],
  );
  await assert.rejects(
    waiveAdvance({
      orderId: o.id,
      adminId: "a2",
      reason: "second waiver attempt",
    }),
  );
  await assert.rejects(
    admin(() => adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN)),
    /staff review/,
  ); // waiving the advance does not waive the review
  await reviewTrustOrder({
    orderId: o.id,
    adminId: "a1",
    note: "phoned, regular buyer",
  });
  await admin(() => adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN));
});

test("the customer's OWN website order history never affects trust or the advance (Phase 7.3: only external courier/fraud-check history counts)", async () => {
  await saveAdvanceSettings(policy, "a1");
  for (let i = 0; i < 3; i++)
    db.insert("order", {
      id: `old${i}`,
      userId: "u9",
      status: "DELIVERED",
      advanceRequired: 0,
      advancePaid: 0,
    });
  const o = await order("u9", claim);
  assert.deepEqual([db.get("order", o.id).trustScore, Number(db.get("order", o.id).advanceRequired)], [50, 200]);   // three delivered website orders earn nothing
  db.insert("order", {
    id: "bad",
    userId: "u9",
    status: "FAILED_DELIVERY",
    advanceRequired: 0,
    advancePaid: 0,
  });
  const o2 = await order("u9", claim);
  assert.deepEqual([db.get("order", o2.id).trustScore, Number(db.get("order", o2.id).advanceRequired)], [50, 200]);   // and a failed website order costs nothing either
});

test("invalid policies are refused", async () => {
  await assert.rejects(
    saveAdvanceSettings({ ...policy, reducedAmount: 500 }, "a1"),
  );
  await assert.rejects(saveAdvanceSettings({ ...policy, lowBelow: 90 }, "a1"));
  await assert.rejects(
    saveAdvanceSettings({ ...policy, zones: [] as never }, "a1"),
  );
});
