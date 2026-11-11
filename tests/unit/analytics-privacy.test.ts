import { test } from "node:test";
import assert from "node:assert/strict";
import { analyticsPath, isTrackablePath, shouldSendPageView } from "@/lib/analytics/privacy";
import { purchaseEventId } from "@/lib/analytics/ids";
import { CONFIRMATION_COOKIE_PATH, encodeConfirmation, tokenForOrder } from "@/lib/confirmation-cookie";

test("private/secret-bearing pages never load analytics", () => {
  for (const p of ["/admin", "/admin/orders/abc", "/account", "/account/orders/AP-1/invoice", "/login", "/register", "/forgot-password", "/reset-password", "/api/courier/webhook"]) {
    assert.equal(isTrackablePath(p), false, p);
  }
  for (const p of ["/", "/shop", "/shop/vases", "/products/clay-vase", "/checkout", "/checkout/confirmation/AP-202610-000001", "/campaign", "/search", "/administrator", "/accounting"]) {
    assert.equal(isTrackablePath(p), true, p);
  }
});

test("page views report the path only — never query strings, hashes or order numbers", () => {
  assert.equal(analyticsPath("/shop?q=secret&token=abc#frag"), "/shop");
  assert.equal(analyticsPath("/search?q=my+private+search"), "/search");
  assert.equal(analyticsPath("/checkout/confirmation/AP-202610-000001"), "/checkout/confirmation");
  assert.equal(analyticsPath("/checkout/confirmation/AP-202610-000001?token=abc123"), "/checkout/confirmation");
  assert.equal(analyticsPath("/products/clay-vase"), "/products/clay-vase");
  assert.equal(analyticsPath(""), "/");
});

test("a page view is sent once per path change (no duplicates)", () => {
  assert.equal(shouldSendPageView(null, "/shop"), true);
  assert.equal(shouldSendPageView("/shop", "/shop"), false);
  assert.equal(shouldSendPageView("/shop", "/products/x"), true);
});

test("purchase event id is stable (browser + server dedupe) and contains no customer data", () => {
  assert.equal(purchaseEventId("AP-202610-000001"), "purchase_AP-202610-000001");
});

test("confirmation cookie: round trip, exact-order binding, malformed values rejected", () => {
  const token = "ckx8f3k1z0000abcd1234efgh";
  const value = encodeConfirmation("AP-202610-000001", token)!;
  assert.equal(value, `AP-202610-000001.${token}`);
  assert.equal(tokenForOrder(value, "AP-202610-000001"), token);
  assert.equal(tokenForOrder(value, "AP-202610-000002"), undefined); // cookie for a different order
  for (const bad of [undefined, null, "", "nodot", ".tok", "AP-1.short", `AP-202610-000001.${token}!`, `evil.${token}`]) {
    assert.equal(tokenForOrder(bad as never, "AP-202610-000001"), undefined, String(bad));
  }
  assert.equal(encodeConfirmation("AP-202610-000001", "short"), null);
  assert.equal(encodeConfirmation("not-an-order", token), null);
  assert.equal(CONFIRMATION_COOKIE_PATH, "/checkout/confirmation");
});
