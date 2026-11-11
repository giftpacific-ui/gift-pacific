import { test } from "node:test";
import assert from "node:assert/strict";
import { getWalletProvider } from "../../src/lib/payments/provider";

test("no wallet API adapter is registered until one is built from official documentation (no fake success path exists)", () => {
  assert.equal(getWalletProvider("BKASH"), null);
  assert.equal(getWalletProvider("NAGAD"), null);
});
