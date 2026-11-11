/** Pure rules for the repeat-purchase delivery reward (server-authoritative; the checkout UI only previews with these). */
export type RewardTerms = { percent: number; maxDiscount: number | null; minOrderAmount: number; stackable: boolean };

export type RewardQuote =
  | { ok: true; discount: number }
  | { ok: false; reason: "no_delivery_charge" | "below_minimum" | "no_stacking" };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Discount on the DELIVERY charge only.
 *  - eligible base = the delivery charge actually billed (0 when delivery is already free → nothing to discount);
 *  - the order subtotal (after any coupon) must reach the reward's minimum;
 *  - if the reward is not stackable it cannot be combined with a product coupon;
 *  - never more than the optional cap, never more than the delivery charge.
 */
export function quoteDeliveryReward(terms: RewardTerms, i: { deliveryCharge: number; subtotalAfterCoupon: number; couponApplied: boolean }): RewardQuote {
  if (i.deliveryCharge <= 0) return { ok: false, reason: "no_delivery_charge" };
  if (i.subtotalAfterCoupon < terms.minOrderAmount) return { ok: false, reason: "below_minimum" };
  if (i.couponApplied && !terms.stackable) return { ok: false, reason: "no_stacking" };
  let d = round2((i.deliveryCharge * terms.percent) / 100);
  if (terms.maxDiscount !== null) d = Math.min(d, terms.maxDiscount);
  d = Math.min(d, i.deliveryCharge);
  return { ok: true, discount: round2(Math.max(d, 0)) };
}

export type RewardSettingsInput = {
  rewardEnabled: boolean;
  rewardDeliveryPercent: number;
  rewardMinOrderAmount: number;
  rewardMaxDiscount: number | null;
  rewardValidityDays: number | null;
  rewardOncePerCustomer: boolean;
  rewardStackWithCoupon: boolean;
};

/** Returns an error message or null. */
export function validateRewardSettings(s: RewardSettingsInput): string | null {
  if (!Number.isInteger(s.rewardDeliveryPercent) || s.rewardDeliveryPercent < 1 || s.rewardDeliveryPercent > 100) return "The delivery discount must be a whole percentage from 1 to 100.";
  if (!Number.isFinite(s.rewardMinOrderAmount) || s.rewardMinOrderAmount < 0) return "The minimum order amount cannot be negative.";
  if (s.rewardMaxDiscount !== null && (!Number.isFinite(s.rewardMaxDiscount) || s.rewardMaxDiscount < 0)) return "The maximum discount cannot be negative.";
  if (s.rewardValidityDays !== null && (!Number.isInteger(s.rewardValidityDays) || s.rewardValidityDays < 1 || s.rewardValidityDays > 3650)) return "Validity must be a whole number of days (1–3650), or empty for no expiry.";
  return null;
}
