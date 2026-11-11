import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteDeliveryReward, validateRewardSettings } from "../../src/lib/rewards";

const terms = { percent: 50, maxDiscount: null as number | null, minOrderAmount: 0, stackable: true };
const q = (t = terms, i = { deliveryCharge: 120, subtotalAfterCoupon: 1000, couponApplied: false }) => quoteDeliveryReward(t, i);

test("50% of the delivery charge only — never the product subtotal", () => {
  assert.deepEqual(q(), { ok: true, discount: 60 });
  assert.deepEqual(q({ ...terms, percent: 100 }), { ok: true, discount: 120 });
  assert.deepEqual(q({ ...terms, percent: 30 }, { deliveryCharge: 99, subtotalAfterCoupon: 5000, couponApplied: false }), { ok: true, discount: 29.7 });
});
test("cap and delivery-charge ceiling", () => {
  assert.deepEqual(q({ ...terms, maxDiscount: 40 }), { ok: true, discount: 40 });
  assert.deepEqual(q({ ...terms, maxDiscount: 500, percent: 100 }), { ok: true, discount: 120 });
});
test("free delivery means nothing to discount; minimum and stacking rules apply", () => {
  assert.deepEqual(q(terms, { deliveryCharge: 0, subtotalAfterCoupon: 1000, couponApplied: false }), { ok: false, reason: "no_delivery_charge" });
  assert.deepEqual(q({ ...terms, minOrderAmount: 1500 }), { ok: false, reason: "below_minimum" });
  assert.deepEqual(q({ ...terms, minOrderAmount: 1000 }), { ok: true, discount: 60 }); // boundary: equal qualifies
  assert.deepEqual(q({ ...terms, stackable: false }, { deliveryCharge: 120, subtotalAfterCoupon: 1000, couponApplied: true }), { ok: false, reason: "no_stacking" });
  assert.equal(q({ ...terms, stackable: true }, { deliveryCharge: 120, subtotalAfterCoupon: 1000, couponApplied: true }).ok, true);
});
test("settings validation", () => {
  const ok = { rewardEnabled: true, rewardDeliveryPercent: 50, rewardMinOrderAmount: 0, rewardMaxDiscount: null, rewardValidityDays: 90, rewardOncePerCustomer: false, rewardStackWithCoupon: true };
  assert.equal(validateRewardSettings(ok), null);
  for (const bad of [{ rewardDeliveryPercent: 0 }, { rewardDeliveryPercent: 101 }, { rewardDeliveryPercent: 12.5 }, { rewardMinOrderAmount: -1 }, { rewardMaxDiscount: -5 }, { rewardValidityDays: 0 }]) {
    assert.ok(validateRewardSettings({ ...ok, ...bad }), JSON.stringify(bad));
  }
});
