import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { listRewardsForUser, saveRewardSettings } from "@/server/services/reward.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); });
const as = (sub: string) => <T,>(fn: () => Promise<T>) => runAs({ sub }, fn);
const rewards = () => db.rows("customerReward");

async function enable(over: Record<string, unknown> = {}) {
  await saveRewardSettings({ rewardEnabled: true, rewardDeliveryPercent: 50, rewardMinOrderAmount: 0, rewardMaxDiscount: null, rewardValidityDays: null, rewardOncePerCustomer: false, rewardStackWithCoupon: true, ...over } as never);
}
/** Place an order as `user`, then drive it to DELIVERED. */
async function deliveredOrder(user: string, productId = "p-standard") {
  const o = await as(user)(async () => { await addItemToCart({ productId, quantity: 1 }); return placeOrder({ ...emptyCheckout }); });
  for (const st of ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await runAs("admin", () => adminUpdateOrderStatus(o.id, st, undefined, TEST_ADMIN));
  return o;
}

test("a reward is issued when an order is DELIVERED, exactly once even if the status is re-applied", async () => {
  await enable();
  const o = await deliveredOrder("u1");
  assert.equal(rewards().length, 1);
  assert.deepEqual([rewards()[0].userId, rewards()[0].orderId, rewards()[0].percent, rewards()[0].status], ["u1", o.id, 50, "AVAILABLE"]);
  assert.match(String(rewards()[0].code), /^RWD-[A-Z2-9]{10}$/);
  await runAs("admin", () => adminUpdateOrderStatus(o.id, "REFUND_REQUESTED", undefined, TEST_ADMIN)).catch(() => undefined);
  assert.equal(rewards().length, 1);
});

test("nothing is issued when disabled, below the minimum, or (once-per-customer) the customer already has one", async () => {
  await deliveredOrder("u0"); // not enabled
  assert.equal(rewards().length, 0);
  await enable({ rewardMinOrderAmount: 999999 });
  await deliveredOrder("u2");
  assert.equal(rewards().length, 0);
  await enable({ rewardOncePerCustomer: true });
  await deliveredOrder("u3");
  await deliveredOrder("u3");
  assert.equal(rewards().filter((r) => r.userId === "u3").length, 1);
});

test("settings are validated before saving", async () => {
  await assert.rejects(enable({ rewardDeliveryPercent: 0 }), /percentage/);
  await assert.rejects(enable({ rewardDeliveryPercent: 150 }));
  await assert.rejects(enable({ rewardMinOrderAmount: -1 }));
});

test("opt-in redemption discounts only the delivery charge, consumes the reward once, and reports its own rewards only", async () => {
  await enable();
  await deliveredOrder("u1");
  const rid = rewards()[0].id as string;
  assert.equal((await listRewardsForUser("u2")).length, 0); // another customer sees nothing
  const o = await as("u1")(async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder({ ...emptyCheckout, rewardId: rid }); });
  const row = db.get("order", o.id);
  const gross = Number(row.shippingTotal) + Number(row.deliveryDiscount);
  assert.ok(gross > 0);
  assert.equal(Number(row.deliveryDiscount), Math.round(gross * 50) / 100);
  assert.equal(Number(row.total), Number(row.subtotal) - Number(row.discountTotal) + Number(row.shippingTotal) + Number(row.taxTotal));
  assert.deepEqual([db.get("customerReward", rid).status, db.get("customerReward", rid).usedOrderId], ["USED", o.id]);
  await assert.rejects(as("u1")(async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder({ ...emptyCheckout, rewardId: rid }); }), /no longer available/);
});

test("another customer's reward, an expired reward, or a guest cannot redeem", async () => {
  await enable();
  await deliveredOrder("u1");
  const rid = rewards()[0].id as string;
  await assert.rejects(as("u2")(async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder({ ...emptyCheckout, rewardId: rid }); }), /no longer available/);
  await assert.rejects(runAs(null, async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder({ ...emptyCheckout, rewardId: rid }); }), /sign in/);
  db.patch("customerReward", rid, { expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(as("u1")(async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder({ ...emptyCheckout, rewardId: rid }); }), /no longer available/);
  assert.equal(db.get("customerReward", rid).status, "AVAILABLE");
});

test("a failed checkout does not consume the reward; cancelling the redeeming order gives it back; refunding the earning order withdraws it", async () => {
  await enable();
  const earning = await deliveredOrder("u1");
  const rid = rewards()[0].id as string;
  db.insert("product", { id: "p-last", name: "Last", slug: "last", status: "ACTIVE", price: 10, stock: 1 });
  await as("u1")(() => addItemToCart({ productId: "p-last", quantity: 1 }));
  db.patch("product", "p-last", { stock: 0 }); // sold out underneath the customer
  await assert.rejects(as("u1")(() => placeOrder({ ...emptyCheckout, rewardId: rid })));
  assert.equal(db.get("customerReward", rid).status, "AVAILABLE");
  db.remove("cartItem", (r) => r.productId === "p-last"); // the customer drops the sold-out line from the cart

  const o = await as("u1")(async () => { await addItemToCart({ productId: "p-standard", quantity: 1 }); return placeOrder({ ...emptyCheckout, rewardId: rid }); });
  assert.equal(db.get("customerReward", rid).status, "USED");
  await runAs("admin", () => adminUpdateOrderStatus(o.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(db.get("customerReward", rid).status, "AVAILABLE");
  assert.equal(db.get("customerReward", rid).usedOrderId, null);

  await runAs("admin", () => adminUpdateOrderStatus(earning.id, "REFUND_REQUESTED", undefined, TEST_ADMIN));
  await runAs("admin", () => adminUpdateOrderStatus(earning.id, "REFUNDED", undefined, TEST_ADMIN));
  assert.equal(db.get("customerReward", rid).status, "REVOKED");
});
