import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttributeWhere,
  parseAttributeFilters,
  slugifyKey,
  validateAttributeDefinition,
  validateAttributeValue,
  type AttributeDef,
} from "@/lib/attributes";

const def = (o: Partial<AttributeDef> & Pick<AttributeDef, "valueType">): AttributeDef & { isFilterable: boolean } => ({
  id: "a1", slug: "attr", name: "Attr", unit: null, minNumber: null, maxNumber: null, maxLength: null, isRequired: false,
  options: [], isFilterable: true, ...o,
});
const colour = def({ id: "col", slug: "colour", name: "Colour", valueType: "SELECT", options: [{ id: "o-red", value: "red", label: "Red" }, { id: "o-blue", value: "blue", label: "Blue" }] });
const tags = def({ id: "tag", slug: "features", name: "Features", valueType: "MULTI_SELECT", options: [{ id: "t1", value: "washable", label: "Washable" }, { id: "t2", value: "foldable", label: "Foldable" }] });
const width = def({ id: "w", slug: "width", name: "Width", valueType: "NUMBER", unit: "cm", minNumber: 0, maxNumber: 500 });
const waterproof = def({ id: "wp", slug: "waterproof", name: "Waterproof", valueType: "BOOLEAN" });
const notes = def({ id: "n", slug: "notes", name: "Notes", valueType: "TEXT", maxLength: 10 });
const all = [colour, tags, width, waterproof, notes];

test("values: each type accepts valid input and rejects invalid input", () => {
  assert.deepEqual(validateAttributeValue(notes, "  hello ").ok && (validateAttributeValue(notes, "  hello ") as never as { value: unknown }).value, { kind: "text", value: "hello" });
  assert.equal(validateAttributeValue(notes, "x".repeat(11)).ok, false);
  assert.equal(validateAttributeValue(notes, 5).ok, false);
  for (const good of [0, 12.5, "12.5", " 7 ", 500]) assert.equal(validateAttributeValue(width, good).ok, true, String(good));
  for (const bad of [-1, 501, "abc", NaN, Infinity, "1e9999", 1.23456, {}, [], "12cm"]) {
    const r = validateAttributeValue(width, bad);
    assert.ok(!r.ok || r.value === null, String(bad));                    // blank-ish values are "unset", the rest invalid
  }
  assert.equal(validateAttributeValue(width, "1.23456").ok, false);
  assert.equal(validateAttributeValue(waterproof, true).ok, true);
  assert.equal(validateAttributeValue(waterproof, "false").ok, true);
  assert.equal(validateAttributeValue(waterproof, "yes").ok, false);
  assert.equal(validateAttributeValue(colour, "o-red").ok, true);
  assert.equal(validateAttributeValue(colour, "o-green").ok, false);
  assert.equal(validateAttributeValue(colour, ["o-red"]).ok, false);
  assert.equal(validateAttributeValue(tags, ["t1", "t2", "t1"]).ok && (validateAttributeValue(tags, ["t1", "t2", "t1"]) as never as { value: { optionIds: string[] } }).value.optionIds.length, 2);
  assert.equal(validateAttributeValue(tags, ["t1", "nope"]).ok, false);
  assert.equal(validateAttributeValue(tags, "t1").ok, false);
});

test("values: required vs optional; blank means unset", () => {
  for (const blank of [undefined, null, "", "   ", []]) {
    const r = validateAttributeValue(notes, blank);
    assert.ok(r.ok && r.value === null);
    assert.equal(validateAttributeValue({ ...notes, isRequired: true }, blank).ok, false);
  }
  assert.equal(validateAttributeValue(waterproof, false).ok, true);          // false is a real answer, not "blank"
});

test("definitions: units, ranges, lengths and filterability are validated", () => {
  assert.equal(validateAttributeDefinition({ name: "Width", valueType: "NUMBER", unit: "cm", minNumber: 0, maxNumber: 10, isFilterable: true }), null);
  for (const bad of [
    { name: " ", valueType: "TEXT" as const }, { name: "x", valueType: "TEXT" as const, unit: "cm" },
    { name: "x", valueType: "NUMBER" as const, minNumber: 5, maxNumber: 1 }, { name: "x", valueType: "BOOLEAN" as const, minNumber: 1 },
    { name: "x", valueType: "NUMBER" as const, maxLength: 5 }, { name: "x", valueType: "TEXT" as const, isFilterable: true },
    { name: "x", valueType: "TEXT" as const, maxLength: 99999 }, { name: "x", valueType: "NUMBER" as const, unit: "x".repeat(13) },
  ]) assert.ok(validateAttributeDefinition(bad), JSON.stringify(bad));
  assert.equal(slugifyKey("  Wood Type / Finish! "), "wood-type-finish");
});

test("filters: valid params become typed filters", () => {
  const f = parseAttributeFilters({ "a.colour": "red,blue", "a.width": "10..50", "a.waterproof": "true", "a.features": "washable" }, all);
  assert.deepEqual(f, [
    { attributeId: "col", kind: "options", optionIds: ["o-red", "o-blue"] },
    { attributeId: "w", kind: "range", min: 10, max: 50 },
    { attributeId: "wp", kind: "boolean", value: true },
    { attributeId: "tag", kind: "options", optionIds: ["t1"] },
  ]);
  assert.deepEqual(parseAttributeFilters({ "a.width": "..50" }, all), [{ attributeId: "w", kind: "range", min: null, max: 50 }]);
  assert.deepEqual(parseAttributeFilters({ "a.width": "10.." }, all), [{ attributeId: "w", kind: "range", min: 10, max: null }]);
});

test("filters: hostile or unknown input is dropped, never interpreted", () => {
  const hostile: Record<string, string> = {
    "a.nope": "red", "a.notes": "anything",                         // unknown slug / TEXT attribute (not filterable)
    "a.colour": "'; DROP TABLE \"Product\"; --",                    // unknown option value
    "a.width": "10..abc", "a.waterproof": "maybe", "a.features": "x".repeat(400),
    "colour": "red", "a.": "red", "a.__proto__": "x", "a.constructor": "x",
  };
  assert.deepEqual(parseAttributeFilters(hostile, all), []);
  assert.deepEqual(parseAttributeFilters({ "a.width": "50..10" }, all), []);                 // inverted range
  assert.deepEqual(parseAttributeFilters({ "a.colour": ["red", "blue"] }, all), [{ attributeId: "col", kind: "options", optionIds: ["o-red", "o-blue"] }]);
  assert.deepEqual(parseAttributeFilters({ "a.colour": "red", "a.width": "1..2" }, [{ ...colour, isFilterable: false }, width]).map((x) => x.attributeId), ["w"]); // not filterable => ignored
  // bounded: at most 6 filters and 10 values each
  const many = Array.from({ length: 12 }, (_, i) => def({ id: `n${i}`, slug: `n${i}`, valueType: "BOOLEAN" }));
  assert.equal(parseAttributeFilters(Object.fromEntries(many.map((d) => [`a.${d.slug}`, "true"])), many).length, 6);
  const big = def({ id: "big", slug: "big", valueType: "SELECT", options: Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, value: `v${i}`, label: `V${i}` })) });
  const r = parseAttributeFilters({ "a.big": Array.from({ length: 30 }, (_, i) => `v${i}`).join(",") }, [big]);
  assert.equal((r[0] as { optionIds: string[] }).optionIds.length, 10);
});

test("where clauses are typed Prisma inputs (one AND clause per filter), never raw SQL", () => {
  const where = buildAttributeWhere(parseAttributeFilters({ "a.colour": "red", "a.width": "10..50", "a.waterproof": "false" }, all));
  assert.deepEqual(where, [
    { attributeOptions: { some: { attributeId: "col", optionId: { in: ["o-red"] } } } },
    { attributeValues: { some: { attributeId: "w", valueNumber: { gte: 10, lte: 50 } } } },
    { attributeValues: { some: { attributeId: "wp", valueBoolean: false } } },
  ]);
  assert.deepEqual(buildAttributeWhere([]), []);
  assert.ok(!JSON.stringify(where).toLowerCase().includes("select ") && !JSON.stringify(where).includes("$queryRaw"));
});
