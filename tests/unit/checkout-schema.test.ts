import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// checkout.ts uses zod 4 APIs (z.email, {error}). Only meaningful with the
// project's real zod 4; skipped when only an older zod copy is available.
const zodVersion: string = (() => {
  try { return createRequire(import.meta.url)("zod/package.json").version; } catch { return "0"; }
})();
const isZod4 = Number(zodVersion.split(".")[0]) >= 4;

test("checkout schema rejects STRIPE / SSLCOMMERZ (server-side), accepts COD", { skip: !isZod4 && "needs zod >= 4 (project dependency)" }, async () => {
  const { checkoutSchema } = await import("@/lib/validations/checkout");
  const base = {
    email: "a@b.co", phone: "+8801711000000",
    shippingAddress: { fullName: "A B", phone: "+8801711000000", line1: "House 1", city: "Dhaka", country: "Bangladesh" },
    billingSameAsShipping: true, deliveryZone: "DHAKA_CITY",
  };
  assert.equal(checkoutSchema.safeParse({ ...base, paymentMethod: "COD" }).success, true);
  for (const m of ["STRIPE", "SSLCOMMERZ", "cod", "", undefined]) {
    assert.equal(checkoutSchema.safeParse({ ...base, paymentMethod: m }).success, false, String(m));
  }
});

// ---- Bangladesh-only checkout phone (Phase 7.4) --------------------------------------------------------------------------------------------
const skipUnlessZod4 = { skip: !isZod4 && "needs zod >= 4 (project dependency)" };
const checkoutBase = (phone: string, shippingPhone: string = phone) => ({
  email: "a@b.co", phone,
  shippingAddress: { fullName: "A B", phone: shippingPhone, line1: "House 1", city: "Dhaka", country: "Bangladesh" },
  billingSameAsShipping: true, deliveryZone: "DHAKA_CITY", paymentMethod: "COD",
});

test("checkout accepts 01XXXXXXXXX and +8801XXXXXXXXX and stores both as one normalised value", skipUnlessZod4, async () => {
  const { checkoutSchema } = await import("@/lib/validations/checkout");
  for (const input of ["01711000000", "+8801711000000"]) {
    const r = checkoutSchema.safeParse(checkoutBase(input));
    assert.equal(r.success, true, input);
    if (r.success) {
      assert.equal(r.data.phone, "01711000000", input);
      assert.equal(r.data.shippingAddress.phone, "01711000000", input);
    }
  }
  // the contact phone and the delivery phone may be different numbers; each is normalised on its own
  const mixed = checkoutSchema.safeParse(checkoutBase("+8801711000000", "01911223344"));
  assert.equal(mixed.success && mixed.data.shippingAddress.phone, "01911223344");
});

test("other ways of writing the same Bangladesh number are normalised too (country code without +, 00 prefix, spaces and dashes)", skipUnlessZod4, async () => {
  const { checkoutSchema } = await import("@/lib/validations/checkout");
  for (const input of ["8801711000000", "008801711000000", "+88 01711-000 000", "  01711000000  ", "017-1100 0000"]) {
    const r = checkoutSchema.safeParse(checkoutBase(input));
    assert.equal(r.success && r.data.shippingAddress.phone, "01711000000", input);
    assert.equal(r.success && r.data.phone, "01711000000", input);
  }
  for (const prefix of ["013", "014", "015", "016", "017", "018", "019"]) {
    assert.equal(checkoutSchema.safeParse(checkoutBase(`${prefix}12345678`)).success, true, prefix);
  }
});

test("international and malformed numbers are rejected with a message naming the accepted formats", skipUnlessZod4, async () => {
  const { checkoutSchema, BD_PHONE_MESSAGE } = await import("@/lib/validations/checkout");
  const bad = [
    "+14155552671",        // USA
    "+447911123456",       // UK
    "+919876543210",       // India
    "+966501234567",       // Saudi Arabia
    "0014155552671",       // USA with 00 prefix
    "+8801711000",         // Bangladesh country code, too short
    "+88017110000000",     // too long
    "+8801211000000",      // not a mobile operator prefix
    "01211000000", "0171100000", "017110000000", "11711000000",
    "123456",              // 6 characters passed the old rule
    "abc", "", "   ", "+88 01711 0000 00 99", "01711-00000x",
  ];
  for (const input of bad) {
    const contact = checkoutSchema.safeParse(checkoutBase(input, "01711000000"));
    assert.equal(contact.success, false, `contact ${JSON.stringify(input)}`);
    const delivery = checkoutSchema.safeParse(checkoutBase("01711000000", input));
    assert.equal(delivery.success, false, `delivery ${JSON.stringify(input)}`);
    if (!delivery.success && input.trim() !== "") {
      const msgs = delivery.error.issues.filter((i) => i.path.join(".") === "shippingAddress.phone").map((i) => i.message);
      assert.ok(msgs.includes(BD_PHONE_MESSAGE), `${JSON.stringify(input)} -> ${JSON.stringify(msgs)}`);
    }
  }
  assert.match(BD_PHONE_MESSAGE, /01XXXXXXXXX/);
  assert.match(BD_PHONE_MESSAGE, /\+8801XXXXXXXXX/);
});

test("the phone rule is enforced by the schema the server action uses (not only by the form)", skipUnlessZod4, async () => {
  const { readFileSync } = await import("node:fs");
  const action = readFileSync("src/server/actions/checkout.actions.ts", "utf8");
  assert.match(action, /checkoutSchema\.safeParse\(input\)/);
  const form = readFileSync("src/features/checkout/checkout-form.tsx", "utf8");
  assert.match(form, /zodResolver\(checkoutSchema\)/);                 // the form uses the same schema, so the browser and the server agree
  const schema = readFileSync("src/lib/validations/checkout.ts", "utf8");
  assert.match(schema, /normalizeBdPhone/);                            // one normaliser for checkout, courier and fraud check
});
