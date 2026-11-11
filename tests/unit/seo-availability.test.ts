import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaAvailability } from "../../src/lib/seo-availability";

const base = { trackInventory: true, allowBackorder: false, type: "STANDARD", stock: 0, variants: [] as { stock: number; allowBackorder: boolean }[] };

test("on hand → InStock; nothing on hand but accepting procurement orders → BackOrder; blocked → OutOfStock", () => {
  assert.equal(schemaAvailability({ ...base, stock: 3 }, true), "https://schema.org/InStock");
  assert.equal(schemaAvailability({ ...base, allowBackorder: true }, true), "https://schema.org/BackOrder");
  assert.equal(schemaAvailability(base, false), "https://schema.org/OutOfStock");
  assert.equal(schemaAvailability({ ...base, allowBackorder: true }, false), "https://schema.org/OutOfStock"); // cap reached
});

test("untracked products are InStock; variant products look at their variants", () => {
  assert.equal(schemaAvailability({ ...base, trackInventory: false }, true), "https://schema.org/InStock");
  assert.equal(schemaAvailability({ ...base, type: "VARIANT", variants: [{ stock: 0, allowBackorder: true }] }, true), "https://schema.org/BackOrder");
  assert.equal(schemaAvailability({ ...base, type: "VARIANT", variants: [{ stock: 2, allowBackorder: false }] }, true), "https://schema.org/InStock");
});
