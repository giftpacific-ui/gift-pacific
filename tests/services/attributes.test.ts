import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import {
  adminDeleteGroup, adminDeleteOption, adminGetProductAttributeData, adminSaveAttribute, adminSaveGroup,
  adminSaveOption, adminSaveProductAttributes, getProductSpecifications, resolveAttributeWhere,
} from "@/server/services/attribute.service";
import { listProducts } from "@/server/services/product.service";

let db: FakeDb;
const guest = <T,>(fn: () => Promise<T>) => runAs(null, fn);
beforeEach(() => { db = freshDb(); seedCatalog(db); });

async function setup() {
  await adminSaveGroup(null, { name: "Materials" });
  await adminSaveGroup(null, { name: "Dimensions", sortOrder: 1 });
  const [mat, dim] = db.rows("attributeGroup");
  await adminSaveAttribute(null, { groupId: mat.id, name: "Wood type", valueType: "SELECT", isFilterable: true });
  await adminSaveAttribute(null, { groupId: mat.id, name: "Care", valueType: "MULTI_SELECT", isFilterable: true });
  await adminSaveAttribute(null, { groupId: dim.id, name: "Width", valueType: "NUMBER", unit: "cm", minNumber: 0, maxNumber: 500, isFilterable: true });
  await adminSaveAttribute(null, { groupId: dim.id, name: "Handmade", valueType: "BOOLEAN", isFilterable: true });
  await adminSaveAttribute(null, { groupId: dim.id, name: "Note", valueType: "TEXT", maxLength: 20, isRequired: true });
  const attr = (slug: string) => db.rows("attribute").find((a) => a.slug === slug)!;
  await adminSaveOption(attr("wood-type").id, null, { label: "Walnut" });
  await adminSaveOption(attr("wood-type").id, null, { label: "Oak" });
  await adminSaveOption(attr("care").id, null, { label: "Hand wash" });
  await adminSaveOption(attr("care").id, null, { label: "Dry clean" });
  const opt = (a: string, v: string) => db.rows("attributeOption").find((o) => o.attributeId === attr(a).id && o.value === v)!.id;
  return { attr, opt };
}

test("definitions: slugs are unique, types are validated, options belong to choice attributes only", () => guest(async () => {
  const { attr } = await setup();
  await adminSaveGroup(null, { name: "Materials" });                                   // same name => distinct slug
  assert.deepEqual(db.rows("attributeGroup").map((g) => g.slug).sort(), ["dimensions", "materials", "materials-2"]);
  await adminSaveAttribute(null, { groupId: db.rows("attributeGroup")[0].id, name: "Wood type", valueType: "TEXT" });
  assert.ok(db.rows("attribute").some((a) => a.slug === "wood-type-2"));
  await assert.rejects(adminSaveAttribute(null, { groupId: "nope", name: "X", valueType: "TEXT" }), /group/i);
  await assert.rejects(adminSaveAttribute(null, { groupId: db.rows("attributeGroup")[0].id, name: "X", valueType: "TEXT", isFilterable: true }), /cannot be used as filters/);
  await assert.rejects(adminSaveOption(attr("width").id, null, { label: "x" }), /Only choice/);
  await assert.rejects(adminSaveOption(attr("wood-type").id, null, { label: "walnut" }), /already exists/);
  await assert.rejects(adminDeleteGroup(db.rows("attributeGroup")[0].id), /Remove or move/);
}));

test("assigning values: validated per type on the server; required enforced; replaced wholesale; separate from variants", () => guest(async () => {
  const { attr, opt } = await setup();
  const p = "p-standard";
  const ok = [
    { attributeId: attr("wood-type").id, value: opt("wood-type", "walnut") },
    { attributeId: attr("care").id, value: [opt("care", "hand-wash"), opt("care", "dry-clean")] },
    { attributeId: attr("width").id, value: "42.5" },
    { attributeId: attr("handmade").id, value: true },
    { attributeId: attr("note").id, value: "fragile" },
  ];
  await adminSaveProductAttributes(p, ok);
  assert.equal(db.rows("productAttributeValue").length, 3);
  assert.equal(db.rows("productAttributeOption").length, 3);
  const bad = (entries: object[], re: RegExp) => assert.rejects(adminSaveProductAttributes(p, entries as never), re);
  await bad([{ attributeId: attr("width").id, value: "600" }, { attributeId: attr("note").id, value: "x" }], /at most 500/);
  await bad([{ attributeId: attr("width").id, value: "wide" }, { attributeId: attr("note").id, value: "x" }], /number/);
  await bad([{ attributeId: attr("wood-type").id, value: "forged-id" }, { attributeId: attr("note").id, value: "x" }], /valid option/);
  await bad([{ attributeId: attr("note").id, value: "x".repeat(21) }], /at most 20/);
  await bad([{ attributeId: attr("note").id, value: "" }], /required/);                  // required when assigned
  await bad([{ attributeId: "ghost", value: "x" }], /no longer exists/);
  await bad([{ attributeId: attr("note").id, value: "a" }, { attributeId: attr("note").id, value: "b" }], /twice/);
  assert.equal(db.rows("productAttributeValue").length, 3);                              // failed saves changed nothing
  await adminSaveProductAttributes(p, [{ attributeId: attr("note").id, value: "only this" }]);   // others are unassigned
  assert.equal(db.rows("productAttributeValue").length, 1);
  assert.equal(db.rows("productAttributeOption").length, 0);
  await assert.rejects(adminSaveProductAttributes("missing", [{ attributeId: attr("note").id, value: "x" }]), /Product not found/);
  const data = await adminGetProductAttributeData(p);
  assert.equal(data.current[attr("note").id], "only this");
}));

test("public specifications: grouped, ordered, formatted with units; hidden/inactive attributes never shown", () => guest(async () => {
  const { attr, opt } = await setup();
  await adminSaveProductAttributes("p-standard", [
    { attributeId: attr("wood-type").id, value: opt("wood-type", "oak") },
    { attributeId: attr("width").id, value: 42.5 },
    { attributeId: attr("handmade").id, value: false },
    { attributeId: attr("note").id, value: "internal-ish" },
  ]);
  await adminSaveAttribute(attr("note").id, { groupId: attr("note").groupId, name: "Note", valueType: "TEXT", maxLength: 20, showOnProduct: false });
  const specs = await getProductSpecifications("p-standard");
  assert.deepEqual(specs, [
    { group: "Materials", items: [{ name: "Wood type", value: "Oak" }] },
    { group: "Dimensions", items: [{ name: "Width", value: "42.5 cm" }, { name: "Handmade", value: "No" }] },
  ]);
  assert.deepEqual(await getProductSpecifications("p-variant"), []);
}));

test("type cannot change once products use the attribute; used options cannot be deleted", () => guest(async () => {
  const { attr, opt } = await setup();
  await adminSaveProductAttributes("p-standard", [{ attributeId: attr("wood-type").id, value: opt("wood-type", "oak") }, { attributeId: attr("note").id, value: "n" }]);
  await assert.rejects(adminSaveAttribute(attr("wood-type").id, { groupId: attr("wood-type").groupId, name: "Wood type", valueType: "TEXT" }), /type cannot change/);
  await assert.rejects(adminDeleteOption(attr("wood-type").id, opt("wood-type", "oak")), /use this option/);
  await adminDeleteOption(attr("wood-type").id, opt("wood-type", "walnut"));            // unused: fine
}));

test("shop filtering through listProducts: typed filters narrow results; hostile params change nothing", () => guest(async () => {
  const { attr, opt } = await setup();
  await adminSaveProductAttributes("p-standard", [{ attributeId: attr("wood-type").id, value: opt("wood-type", "oak") }, { attributeId: attr("width").id, value: 40 }, { attributeId: attr("note").id, value: "a" }]);
  await adminSaveProductAttributes("p-variant", [{ attributeId: attr("wood-type").id, value: opt("wood-type", "walnut") }, { attributeId: attr("width").id, value: 80 }, { attributeId: attr("note").id, value: "a" }]);
  const names = async (params: Record<string, string>) => (await listProducts({ attributeWhere: await resolveAttributeWhere(params) })).items.map((i) => i.name).sort();
  assert.deepEqual(await names({ "a.wood-type": "oak" }), ["Clay Vase"]);
  assert.deepEqual(await names({ "a.wood-type": "oak,walnut" }), ["Clay Mug", "Clay Vase"]);
  assert.deepEqual(await names({ "a.width": "50..100" }), ["Clay Mug"]);
  assert.deepEqual(await names({ "a.wood-type": "walnut", "a.width": "..50" }), []);      // AND semantics
  const all = await names({});
  assert.equal(all.length, 4);
  for (const hostile of [{ "a.nope": "x" }, { "a.wood-type": "'; DROP TABLE x;--" }, { "a.width": "1..zzz" }, { "a.note": "a" }]) {
    assert.deepEqual(await names(hostile), all, JSON.stringify(hostile));                // dropped => no filtering at all
  }
}));
