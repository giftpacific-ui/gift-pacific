import { test } from "node:test";
import assert from "node:assert/strict";
import {
  componentDemand,
  maxComboUnits,
  resolveCombo,
  validateComboConfig,
  validateSlotRules,
  type ComboProduct,
  type ComboTemplate,
} from "@/lib/combo";

const product = (id: string, o: Partial<ComboProduct> = {}): ComboProduct => ({
  id, name: id.toUpperCase(), type: "STANDARD", kind: "SINGLE", status: "ACTIVE", price: 100, costPrice: 40,
  trackInventory: true, allowBackorder: false, stock: 10, variants: [], ...o,
});
const box = product("box", { price: 200 });
const candle = product("candle", { price: 300 });
const soap = product("soap", { price: 150 });
const mug = product("mug", { type: "VARIANT", price: 500, variants: [{ id: "mug-red", name: "Red", price: 550, stock: 2, allowBackorder: false }] });

const custom = (over: Partial<ComboTemplate> = {}): ComboTemplate => ({
  id: "c1", mode: "CUSTOMIZABLE", pricing: "FIXED_PRICE", stockPolicy: "COMPONENTS", basePrice: 1000,
  fixedComponents: [],
  slots: [
    { id: "s-box", label: "Box", minSelect: 1, maxSelect: 1, maxPerOption: 1, options: [{ id: "o-box", productId: "box", variantId: null, priceDelta: 50, product: box }] },
    {
      id: "s-items", label: "Items", minSelect: 1, maxSelect: 3, maxPerOption: 2,
      options: [
        { id: "o-candle", productId: "candle", variantId: null, priceDelta: 0, product: candle },
        { id: "o-soap", productId: "soap", variantId: null, priceDelta: 25, product: soap },
        { id: "o-mug", productId: "mug", variantId: "mug-red", priceDelta: 0, product: mug },
      ],
    },
  ],
  ...over,
});
const fixed = (over: Partial<ComboTemplate> = {}): ComboTemplate => ({
  id: "f1", mode: "FIXED", pricing: "FIXED_PRICE", stockPolicy: "OWN_STOCK", basePrice: 900,
  fixedComponents: [
    { productId: "candle", variantId: null, quantity: 2, product: candle },
    { productId: "soap", variantId: null, quantity: 1, product: soap },
  ],
  slots: [], ...over,
});
const ok = (r: ReturnType<typeof resolveCombo>) => { assert.ok(r.ok, r.ok ? "" : r.message); return r.value; };
const msg = (r: ReturnType<typeof resolveCombo>) => { assert.equal(r.ok, false); return r.ok ? "" : r.message; };
const sel = (slotId: string, optionId: string, quantity = 1) => ({ slotId, optionId, quantity });

test("customizable: FIXED_PRICE = base + surcharges × quantity; components resolved from the template", () => {
  const v = ok(resolveCombo(custom(), [sel("s-box", "o-box"), sel("s-items", "o-candle", 2), sel("s-items", "o-soap")]));
  assert.equal(v.unitPrice, 1000 + 50 + 25);
  assert.deepEqual(v.components.map((c) => [c.productId, c.quantity, c.slotLabel]), [["box", 1, "Box"], ["candle", 2, "Items"], ["soap", 1, "Items"]]);
});

test("customizable: COMPONENT_SUM = sum of current component prices; surcharges ignored; variant price used", () => {
  const v = ok(resolveCombo(custom({ pricing: "COMPONENT_SUM" }), [sel("s-box", "o-box"), sel("s-items", "o-mug"), sel("s-items", "o-soap")]));
  assert.equal(v.unitPrice, 200 + 550 + 150);
});

test("customizable: required, minimum, maximum and per-item limits are enforced", () => {
  assert.match(msg(resolveCombo(custom(), [sel("s-items", "o-candle")])), /Box/);              // required slot missing
  assert.match(msg(resolveCombo(custom(), [sel("s-box", "o-box")])), /Items/);                // required slot missing
  assert.match(msg(resolveCombo(custom(), [sel("s-box", "o-box"), sel("s-items", "o-candle", 2), sel("s-items", "o-soap", 2)])), /at most 3/);
  assert.match(msg(resolveCombo(custom(), [sel("s-box", "o-box"), sel("s-items", "o-candle", 3)])), /at most 2 of "CANDLE"/);
  assert.match(msg(resolveCombo(custom({ slots: [{ ...custom().slots[0], minSelect: 2, maxSelect: 2, maxPerOption: 2 }, custom().slots[1]] }), [sel("s-box", "o-box"), sel("s-items", "o-soap")])), /at least 2/);
});

test("customizable: tampered ids/quantities/shapes are all rejected", () => {
  const good = [sel("s-box", "o-box"), sel("s-items", "o-soap")];
  for (const bad of [
    [sel("s-box", "o-box"), sel("s-items", "NOPE")],                    // unknown option
    [sel("s-box", "o-candle"), sel("s-items", "o-soap")],               // option from another slot
    [sel("ghost", "o-box"), ...good],                                   // unknown slot
    [...good, sel("s-items", "o-soap")],                                // duplicate
    [sel("s-box", "o-box"), sel("s-items", "o-soap", 0)],               // zero
    [sel("s-box", "o-box"), sel("s-items", "o-soap", -1)],              // negative
    [sel("s-box", "o-box"), sel("s-items", "o-soap", 1.5)],             // fractional
    [sel("s-box", "o-box"), sel("s-items", "o-soap", "2" as never)],    // wrong type
    [sel("s-box", "o-box"), sel("s-items", "o-soap", 1_000_000)],       // absurd
    [null, ...good], ["x"], {}, "box", 7, undefined, null,              // garbage
    Array.from({ length: 51 }, () => sel("s-items", "o-soap")),         // flood
  ]) {
    assert.equal(resolveCombo(custom(), bad as never).ok, false, String(JSON.stringify(bad)).slice(0, 60));
  }
  // a client-supplied price/product id is simply not part of the contract: extra keys change nothing
  const v = ok(resolveCombo(custom(), [{ ...sel("s-box", "o-box"), price: 1, productId: "soap" }, sel("s-items", "o-soap")] as never));
  assert.equal(v.unitPrice, 1000 + 50 + 25);
  assert.equal(v.components[0].productId, "box");
});

test("customizable: inactive component, nested combo and unpinned variant product are refused", () => {
  const inactive = custom({ slots: [custom().slots[0], { ...custom().slots[1], options: [{ id: "o-soap", productId: "soap", variantId: null, priceDelta: 0, product: { ...soap, status: "ARCHIVED" } }] }] });
  assert.match(msg(resolveCombo(inactive, [sel("s-box", "o-box"), sel("s-items", "o-soap")])), /no longer available/);
  const nested = custom({ slots: [custom().slots[0], { ...custom().slots[1], options: [{ id: "o-soap", productId: "soap", variantId: null, priceDelta: 0, product: { ...soap, kind: "COMBO" } }] }] });
  assert.match(msg(resolveCombo(nested, [sel("s-box", "o-box"), sel("s-items", "o-soap")])), /combo and cannot be a component/);
  const unpinned = custom({ slots: [custom().slots[0], { ...custom().slots[1], options: [{ id: "o-mug", productId: "mug", variantId: null, priceDelta: 0, product: mug }] }] });
  assert.match(msg(resolveCombo(unpinned, [sel("s-box", "o-box"), sel("s-items", "o-mug")])), /specific option/);
  const gone = custom({ slots: [custom().slots[0], { ...custom().slots[1], options: [{ id: "o-mug", productId: "mug", variantId: "deleted", priceDelta: 0, product: mug }] }] });
  assert.match(msg(resolveCombo(gone, [sel("s-box", "o-box"), sel("s-items", "o-mug")])), /no longer available/);
});

test("selectionKey is order-independent so identical selections merge into one cart line", () => {
  const a = ok(resolveCombo(custom(), [sel("s-box", "o-box"), sel("s-items", "o-soap"), sel("s-items", "o-candle")]));
  const b = ok(resolveCombo(custom(), [sel("s-items", "o-candle"), sel("s-box", "o-box"), sel("s-items", "o-soap")]));
  const c = ok(resolveCombo(custom(), [sel("s-box", "o-box"), sel("s-items", "o-soap", 2)]));
  assert.equal(a.selectionKey, b.selectionKey);
  assert.notEqual(a.selectionKey, c.selectionKey);
});

test("fixed combo: selections are refused; price rules; deactivated component only blocks COMPONENTS policy", () => {
  assert.equal(ok(resolveCombo(fixed(), undefined)).unitPrice, 900);
  assert.equal(ok(resolveCombo(fixed({ pricing: "COMPONENT_SUM" }), [])).unitPrice, 2 * 300 + 150);
  assert.match(msg(resolveCombo(fixed(), [sel("a", "b")])), /fixed contents/);
  assert.match(msg(resolveCombo(fixed({ fixedComponents: [] }), undefined)), /no contents/);
  const dead = fixed({ fixedComponents: [{ productId: "soap", variantId: null, quantity: 1, product: { ...soap, status: "ARCHIVED" } }] });
  assert.equal(dead.stockPolicy, "OWN_STOCK");
  ok(resolveCombo(dead, undefined));                                                       // finished box on the shelf: still sellable
  assert.match(msg(resolveCombo({ ...dead, stockPolicy: "COMPONENTS" }, undefined)), /no longer available/);
});

test("stock arithmetic: units that can be assembled, and per-component demand", () => {
  const v = ok(resolveCombo(custom(), [sel("s-box", "o-box"), sel("s-items", "o-candle", 2), sel("s-items", "o-mug")]));
  // candle: 10/2 = 5, box: 10/1 = 10, mug-red: 2/1 = 2  ->  2 combos
  assert.equal(maxComboUnits(v.components), 2);
  assert.deepEqual(componentDemand(v.components, 3).map((d) => [d.productId, d.variantId, d.quantity]), [["box", null, 3], ["candle", null, 6], ["mug", "mug-red", 3]]);
  assert.equal(maxComboUnits([{ ...v.components[0], trackInventory: false }]), Infinity);
  assert.equal(maxComboUnits([{ ...v.components[0], allowBackorder: true, stock: 0 }]), Infinity);
  assert.equal(maxComboUnits([{ ...v.components[0], stock: 0 }]), 0);
});

test("admin rules: slot limits and combo configuration", () => {
  assert.equal(validateSlotRules({ label: "Box", minSelect: 1, maxSelect: 1, maxPerOption: 1 }), null);
  for (const bad of [
    { label: " ", minSelect: 1, maxSelect: 1, maxPerOption: 1 }, { label: "x", minSelect: -1, maxSelect: 1, maxPerOption: 1 },
    { label: "x", minSelect: 0, maxSelect: 0, maxPerOption: 1 }, { label: "x", minSelect: 3, maxSelect: 2, maxPerOption: 1 },
    { label: "x", minSelect: 1, maxSelect: 2, maxPerOption: 0 }, { label: "x", minSelect: 1, maxSelect: 2.5, maxPerOption: 1 },
    { label: "x", minSelect: 1, maxSelect: 500, maxPerOption: 1 },
  ]) assert.ok(validateSlotRules(bad), JSON.stringify(bad));
  const base = { kind: "COMBO" as const, type: "BUNDLE", comboMode: "FIXED" as const, comboPricing: "FIXED_PRICE" as const, comboStockPolicy: "OWN_STOCK" as const };
  assert.equal(validateComboConfig(base), null);
  assert.ok(validateComboConfig({ ...base, type: "STANDARD" }));
  assert.ok(validateComboConfig({ ...base, comboMode: null }));
  assert.ok(validateComboConfig({ ...base, comboMode: "CUSTOMIZABLE" }));                  // customizable + OWN_STOCK is invalid
  assert.equal(validateComboConfig({ ...base, comboMode: "CUSTOMIZABLE", comboStockPolicy: "COMPONENTS" }), null);
  assert.equal(validateComboConfig({ kind: "SINGLE", type: "VARIANT", comboMode: null, comboPricing: null, comboStockPolicy: null }), null);
  assert.ok(validateComboConfig({ kind: "SINGLE", type: "BUNDLE", comboMode: null, comboPricing: null, comboStockPolicy: null }));
});
