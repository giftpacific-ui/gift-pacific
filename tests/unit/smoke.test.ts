import { test } from "node:test";
import assert from "node:assert/strict";
test("loader + alias work", async () => {
  const m = await import("@/lib/payment-methods");
  assert.equal(m.isPaymentMethodEnabled("COD"), true);
});
