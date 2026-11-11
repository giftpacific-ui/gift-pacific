import { test } from "node:test";
import assert from "node:assert/strict";
import { sellableCustomizationFields, validateCustomizationInput, type CustomizationFieldConfig } from "@/lib/customization";

const fields: CustomizationFieldConfig[] = [
  { label: "Name", fieldKey: "name", type: "TEXT", isRequired: true, options: [], maxLength: 5 },
  { label: "Date", fieldKey: "date", type: "DATE", isRequired: false, options: [], maxLength: null },
  { label: "Color", fieldKey: "color", type: "SELECT", isRequired: false, options: ["Gold", "Silver"], maxLength: null },
];

test("valid input is cleaned and returned", () => {
  assert.deepEqual(validateCustomizationInput(fields, { name: " Anna ", date: "2026-02-28", color: "Gold" }), { ok: true, value: { name: "Anna", date: "2026-02-28", color: "Gold" } });
  assert.deepEqual(validateCustomizationInput(fields, { name: "Bo" }), { ok: true, value: { name: "Bo" } });
});

test("rejects missing required, too long, bad date, bad option", () => {
  assert.equal(validateCustomizationInput(fields, {}).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: "   " }).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: "Abcdef" }).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: "A", date: "2026-02-30" }).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: "A", date: "tomorrow" }).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: "A", color: "Pink" }).ok, false);
});

test("rejects unknown keys and non-string values (no arbitrary JSON into the cart)", () => {
  assert.equal(validateCustomizationInput(fields, { name: "A", evil: "x" }).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: { a: 1 } }).ok, false);
  assert.equal(validateCustomizationInput(fields, { name: 5 }).ok, false);
  assert.equal(validateCustomizationInput(fields, ["x"]).ok, false);
  assert.equal(validateCustomizationInput(fields, "x").ok, false);
});

test("products without fields reject any personalization input", () => {
  assert.deepEqual(validateCustomizationInput([], undefined), { ok: true, value: null });
  assert.deepEqual(validateCustomizationInput([], {}), { ok: true, value: null });
  assert.equal(validateCustomizationInput([], { name: "x" }).ok, false);
});

test("personalization only applies to PERSONALIZED products", () => {
  assert.deepEqual(sellableCustomizationFields({ type: "STANDARD", customizationFields: fields }), []);
  assert.equal(sellableCustomizationFields({ type: "PERSONALIZED", customizationFields: fields }).length, 3);
});
