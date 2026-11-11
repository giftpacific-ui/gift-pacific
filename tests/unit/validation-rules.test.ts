import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activationRequirementError, checkVariantAgainstSiblings, parseVariantOptions, parseVariantOptionsJson,
  readVariantOptions, validateBundleItemRules, validateCouponRules, validateCustomizationFieldConfig,
  validateProductRules, validateVariantRules, type CouponRuleInput, type ProductRuleInput,
} from "@/lib/validation-rules";

const product = (o: Partial<ProductRuleInput> = {}): ProductRuleInput => ({
  type: "STANDARD", status: "ACTIVE", price: 100, compareAtPrice: null, costPrice: null,
  stock: 1, lowStockThreshold: 5, weightGrams: null, ...o,
});
const coupon = (o: Partial<CouponRuleInput> = {}): CouponRuleInput => ({
  code: "SAVE10", type: "PERCENTAGE", value: 10, minPurchase: null, maxDiscount: null,
  usageLimit: null, perUserLimit: null, startsAt: null, endsAt: null, ...o,
});

test("product: price / compareAt / stock rules", () => {
  assert.equal(validateProductRules(product()), null);
  assert.notEqual(validateProductRules(product({ price: 0 })), null);
  assert.notEqual(validateProductRules(product({ price: -5 })), null);
  assert.notEqual(validateProductRules(product({ price: 10.999 })), null);
  assert.notEqual(validateProductRules(product({ price: 1e12 })), null); // would overflow Decimal(10,2)
  assert.notEqual(validateProductRules(product({ compareAtPrice: 100 })), null); // not > price
  assert.notEqual(validateProductRules(product({ compareAtPrice: 50 })), null);
  assert.equal(validateProductRules(product({ compareAtPrice: 150 })), null);
  assert.notEqual(validateProductRules(product({ stock: -1 })), null);
  assert.notEqual(validateProductRules(product({ stock: 1.5 })), null);
  assert.notEqual(validateProductRules(product({ stock: 1e9 })), null);
  assert.notEqual(validateProductRules(product({ costPrice: -1 })), null);
});

test("product activation requirements per type", () => {
  const args = { variantCount: 0, customizationFieldCount: 0, bundleItemCount: 0 };
  assert.notEqual(activationRequirementError({ type: "VARIANT", status: "ACTIVE", ...args }), null);
  assert.notEqual(activationRequirementError({ type: "PERSONALIZED", status: "ACTIVE", ...args }), null);
  assert.notEqual(activationRequirementError({ type: "BUNDLE", status: "ACTIVE", ...args }), null);
  assert.equal(activationRequirementError({ type: "VARIANT", status: "DRAFT", ...args }), null);
  assert.equal(activationRequirementError({ type: "STANDARD", status: "ACTIVE", ...args }), null);
  assert.equal(activationRequirementError({ type: "VARIANT", status: "ACTIVE", ...args, variantCount: 1 }), null);
  assert.equal(activationRequirementError({ type: "BUNDLE", status: "ACTIVE", ...args, bundleItemCount: 1 }), null);
});

test("coupon rules", () => {
  assert.equal(validateCouponRules(coupon()), null);
  assert.notEqual(validateCouponRules(coupon({ value: 101 })), null); // percentage <= 100
  assert.equal(validateCouponRules(coupon({ value: 100 })), null);
  assert.notEqual(validateCouponRules(coupon({ value: 0 })), null);
  assert.notEqual(validateCouponRules(coupon({ value: -5 })), null);
  assert.notEqual(validateCouponRules(coupon({ value: NaN })), null);
  assert.equal(validateCouponRules(coupon({ type: "FIXED", value: 500 })), null);
  assert.notEqual(validateCouponRules(coupon({ type: "FIXED", value: 500.555 })), null);
  assert.notEqual(validateCouponRules(coupon({ type: "FIXED", value: 100, maxDiscount: 50 })), null); // cap is % only
  assert.notEqual(validateCouponRules(coupon({ usageLimit: 0 })), null);
  assert.notEqual(validateCouponRules(coupon({ usageLimit: 1.5 })), null);
  assert.notEqual(validateCouponRules(coupon({ perUserLimit: 0 })), null);
  assert.notEqual(validateCouponRules(coupon({ usageLimit: 5, perUserLimit: 6 })), null);
  assert.equal(validateCouponRules(coupon({ usageLimit: 5, perUserLimit: 5 })), null);
  assert.notEqual(validateCouponRules(coupon({ minPurchase: -1 })), null);
  assert.notEqual(validateCouponRules(coupon({ code: "a b" })), null);
});

test("coupon dates: startsAt must be before endsAt", () => {
  const a = new Date("2026-01-01"), b = new Date("2026-02-01");
  assert.equal(validateCouponRules(coupon({ startsAt: a, endsAt: b })), null);
  assert.notEqual(validateCouponRules(coupon({ startsAt: b, endsAt: a })), null);
  assert.notEqual(validateCouponRules(coupon({ startsAt: a, endsAt: a })), null);
  assert.notEqual(validateCouponRules(coupon({ startsAt: new Date("nope") })), null);
  assert.equal(validateCouponRules(coupon({ startsAt: a })), null);
});

test("variant options JSON is validated, not blindly cast", () => {
  assert.deepEqual(parseVariantOptionsJson('{"Color":" Red "}'), { ok: true, value: { Color: "Red" } });
  for (const bad of ["not json", "[]", "null", '"x"', "5", "{}", '{"Color":5}', '{"Color":""}', '{"Color":{"a":1}}', '{"":"x"}', '{"__proto__":"x"}']) {
    assert.equal(parseVariantOptionsJson(bad).ok, false, bad);
  }
  assert.equal(parseVariantOptions({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" }).ok, false); // too many keys
  // lenient read path never throws on junk
  assert.deepEqual(readVariantOptions(null), {});
  assert.deepEqual(readVariantOptions([1, 2]), {});
  assert.deepEqual(readVariantOptions({ Color: "Red", Bad: 5 }), { Color: "Red" });
});

test("variants: consistent option names and no duplicate combinations", () => {
  const siblings = [{ id: "a", options: { Color: "Red", Size: "S" } }];
  assert.equal(checkVariantAgainstSiblings({ Color: "Red", Size: "M" }, siblings, null), null);
  assert.notEqual(checkVariantAgainstSiblings({ Color: "red", Size: "s" }, siblings, null), null); // duplicate (case-insens.)
  assert.notEqual(checkVariantAgainstSiblings({ Colour: "Red" }, siblings, null), null); // different option names
  assert.equal(checkVariantAgainstSiblings({ Color: "Red", Size: "S" }, siblings, "a"), null); // editing itself
  assert.equal(checkVariantAgainstSiblings({ Anything: "x" }, [], null), null);
  assert.equal(validateVariantRules({ price: 10, stock: 0 }), null);
  assert.notEqual(validateVariantRules({ price: 0, stock: 0 }), null);
  assert.notEqual(validateVariantRules({ price: 10, stock: -1 }), null);
});

test("customization field config: SELECT/COLOR need options; text-only settings; IMAGE_UPLOAD is gone", () => {
  const f = (o: object) => validateCustomizationFieldConfig({
    label: "Name", fieldKey: "name", type: "TEXT", isRequired: true, options: [], maxLength: null, ...o,
  } as never);
  assert.equal(f({}), null);
  assert.notEqual(f({ type: "SELECT" }), null); // no options
  assert.notEqual(f({ type: "COLOR", options: [] }), null);
  assert.equal(f({ type: "SELECT", options: ["A", "B"] }), null);
  assert.notEqual(f({ type: "SELECT", options: ["A", "a"] }), null); // duplicate
  assert.notEqual(f({ type: "SELECT", options: ["A", " "] }), null);
  assert.notEqual(f({ type: "TEXT", options: ["A"] }), null); // options on a text field
  assert.notEqual(f({ type: "DATE", maxLength: 10 }), null);
  assert.notEqual(f({ maxLength: 0 }), null);
  assert.notEqual(f({ maxLength: 5000 }), null);
  assert.equal(f({ type: "TEXTAREA", maxLength: 500 }), null);
  assert.notEqual(f({ type: "IMAGE_UPLOAD" }), null);
  assert.notEqual(f({ fieldKey: "1bad" }), null);
  assert.notEqual(f({ fieldKey: "__proto__" }), null);
  assert.notEqual(f({ label: "  " }), null);
});

test("bundle item rules", () => {
  const ok = { bundleType: "BUNDLE", componentType: "STANDARD", bundleId: "a", componentId: "b", quantity: 2 };
  assert.equal(validateBundleItemRules(ok), null);
  assert.notEqual(validateBundleItemRules({ ...ok, bundleType: "STANDARD" }), null);
  assert.notEqual(validateBundleItemRules({ ...ok, componentId: "a" }), null);
  assert.notEqual(validateBundleItemRules({ ...ok, componentType: "BUNDLE" }), null);
  for (const q of [0, -1, 1.5, 100]) assert.notEqual(validateBundleItemRules({ ...ok, quantity: q }), null);
});
