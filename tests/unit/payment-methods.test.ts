import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPaymentMethodEnabled, isPaymentMethodEnabled, PaymentMethodNotSupportedError } from "@/lib/payment-methods";

test("only COD is enabled", () => {
  assert.equal(isPaymentMethodEnabled("COD"), true);
  for (const m of ["STRIPE", "SSLCOMMERZ", "cod", "", null, undefined, 1, {}]) {
    assert.equal(isPaymentMethodEnabled(m), false, String(m));
    assert.throws(() => assertPaymentMethodEnabled(m), PaymentMethodNotSupportedError);
  }
  assertPaymentMethodEnabled("COD");
});
