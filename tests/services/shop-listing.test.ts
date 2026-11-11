import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { listProducts } from "@/server/services/product.service";

let db: FakeDb;
const guest = <T,>(fn: () => Promise<T>) => runAs(null, fn);
const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name);

beforeEach(() => {
  db = freshDb();
  seedCatalog(db); // singles: Clay Vase, Clay Mug, Couple Frame; combo: Gift Box (legacy fixed OWN_STOCK)
  db.insert("category", { id: "c-home", name: "Home", slug: "home", isActive: true, sortOrder: 0, parentId: null });
  db.insert("product", {
    id: "p-custom", name: "Build Your Box", slug: "build-your-box", type: "BUNDLE", status: "ACTIVE", price: 1000, stock: 0, description: "Make your own box",
    kind: "COMBO", comboMode: "CUSTOMIZABLE", comboPricing: "FIXED_PRICE", comboStockPolicy: "COMPONENTS",
  });
  // newest-first ordering must be applied WITHIN each kind
  const t = (d: number) => new Date(Date.UTC(2026, 0, d));
  for (const [id, day] of [["p-standard", 5], ["p-variant", 4], ["p-pers", 3], ["p-bundle", 1], ["p-custom", 2]] as const) {
    db.product.update({ where: { id }, data: { createdAt: t(day) } });
  }
  db.product.update({ where: { id: "p-standard" }, data: { categoryId: "c-home" } });
  db.product.update({ where: { id: "p-bundle" }, data: { categoryId: "c-home" } });
});

test("default listing shows every combo before any single, newest first within each group", () => guest(async () => {
  const r = await listProducts({});
  assert.deepEqual(names(r), ["Build Your Box", "Gift Box", "Clay Vase", "Clay Mug", "Couple Frame"]);
}));

test("All / Combo / Single filters", () => guest(async () => {
  assert.deepEqual(names(await listProducts({ kind: "COMBO" })), ["Build Your Box", "Gift Box"]);
  assert.deepEqual(names(await listProducts({ kind: "SINGLE" })), ["Clay Vase", "Clay Mug", "Couple Frame"]);
  assert.equal((await listProducts({})).total, 5);
}));

test("category filter is independent of the kind filter and works with and without it", () => guest(async () => {
  assert.deepEqual(names(await listProducts({ categorySlug: "home" })), ["Gift Box", "Clay Vase"]);        // combo first, then single
  assert.deepEqual(names(await listProducts({ categorySlug: "home", kind: "COMBO" })), ["Gift Box"]);
  assert.deepEqual(names(await listProducts({ categorySlug: "home", kind: "SINGLE" })), ["Clay Vase"]);
}));

test("pagination across the combo/single boundary has no gaps or duplicates", () => guest(async () => {
  const seen: string[] = [];
  for (const page of [1, 2, 3]) seen.push(...names(await listProducts({ page, pageSize: 2 })));
  assert.deepEqual(seen, ["Build Your Box", "Gift Box", "Clay Vase", "Clay Mug", "Couple Frame"]);
}));

test("an explicit price sort is honoured and is not forced combos-first", () => guest(async () => {
  assert.deepEqual(names(await listProducts({ sort: "price-asc" })), ["Clay Mug", "Build Your Box", "Clay Vase", "Couple Frame", "Gift Box"]);
}));

test("inactive combos are never listed", () => guest(async () => {
  await db.product.update({ where: { id: "p-custom" }, data: { status: "DRAFT" } });
  assert.deepEqual(names(await listProducts({ kind: "COMBO" })), ["Gift Box"]);
}));
