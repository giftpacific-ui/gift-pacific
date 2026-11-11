import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { adminDeleteBox, adminMoveBox, adminSaveBox, adminToggleBox, getActiveBoxBySlug, getActiveBoxes } from "@/server/services/box.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); });
const input = (o: Record<string, unknown> = {}) => ({ name: "Rose Box", price: 150, stock: 5, sortOrder: 0, isActive: true, ...o });

test("slug is generated from the name; keywords normalised; price must be explicit and non-negative", async () => {
  const { id } = await adminSaveBox(null, input({ seoKeywords: ["Gift, gift ", "box"] }));
  const row = db.rows("box").find((b) => b.id === id)!;
  assert.equal(row.slug, "rose-box");
  assert.deepEqual(row.seoKeywords, ["Gift", "box"]);
  await assert.rejects(adminSaveBox(null, input({ name: "X", price: -1 })), /negative/);
  await assert.rejects(adminSaveBox(null, input({ name: "Y", price: undefined })));
});

test("duplicate slug is refused with a readable message", async () => {
  await adminSaveBox(null, input());
  await assert.rejects(adminSaveBox(null, input()), /already used/);
});

test("public list shows only active boxes in order; inactive boxes are invisible by slug", async () => {
  await adminSaveBox(null, input({ name: "B", sortOrder: 2 }));
  await adminSaveBox(null, input({ name: "A", sortOrder: 1 }));
  await adminSaveBox(null, input({ name: "Hidden", isActive: false }));
  assert.deepEqual((await getActiveBoxes()).map((b) => b.name), ["A", "B"]);
  assert.equal(await getActiveBoxBySlug("hidden"), null);
  assert.equal((await getActiveBoxBySlug("a"))?.name, "A");
});

test("saving a box creates a hidden managed product with the box's own price and stock; edits sync it", async () => {
  const { id } = await adminSaveBox(null, input({ price: 150, stock: 5 }));
  const p = db.rows("product").find((r) => r.isBoxProduct === true)!;
  assert.equal(p.price, 150);
  assert.equal(p.stock, 5);
  assert.equal(p.status, "ACTIVE");
  assert.equal(db.rows("box").find((b) => b.id === id)!.productId, p.id);
  assert.equal((await getActiveBoxBySlug("rose-box"))?.inStock, true);
  await adminSaveBox(id, input({ price: 175, stock: 2, name: "Rose Box+" }));
  const q = db.rows("product").find((r) => r.id === p.id)!;
  assert.deepEqual([q.price, q.stock, q.name, db.rows("product").length], [175, 2, "Rose Box+", 1]); // synced, not duplicated
  await adminSaveBox(id, input({ price: 175, stock: 0, isActive: true }));
  assert.equal((await getActiveBoxBySlug("rose-box"))?.inStock, false);
  await adminSaveBox(id, input({ price: 175, stock: 0, allowBackorder: true }));
  assert.equal((await getActiveBoxBySlug("rose-box"))?.inStock, true);
});

test("deactivating or deleting a box takes its managed product off sale but keeps it for order history", async () => {
  const { id } = await adminSaveBox(null, input());
  await adminToggleBox(id, false);
  assert.equal(db.rows("product").find((r) => r.isBoxProduct === true)!.status, "DRAFT");
  assert.equal(await getActiveBoxBySlug("rose-box"), null);
  await adminToggleBox(id, true);
  assert.equal(db.rows("product").find((r) => r.isBoxProduct === true)!.status, "ACTIVE");
  await adminDeleteBox(id);
  assert.equal(db.rows("box").length, 0);
  assert.equal(db.rows("product").find((r) => r.isBoxProduct === true)!.status, "ARCHIVED");
});

test("a legacy box linked to an ordinary product is left untouched by saves", async () => {
  db.insert("product", { id: "p1", name: "Old product", slug: "old-product", type: "STANDARD", kind: "SINGLE", status: "ACTIVE", price: 200, stock: 3, description: "x" });
  db.insert("box", { id: "legacy", name: "Legacy", slug: "legacy", price: 200, isActive: true, productId: "p1" });
  await adminSaveBox("legacy", input({ name: "Legacy", slug: "legacy", price: 999, stock: 99 }));
  const p = db.rows("product").find((r) => r.id === "p1")!;
  assert.deepEqual([p.price, p.stock, p.name], [200, 3, "Old product"]);
});

test("replacing/deleting an image returns the orphan only if no other box still uses it", async () => {
  const a = await adminSaveBox(null, input({ name: "A", imagePublicId: "giftpacific/boxes/x", imageUrl: "https://res.cloudinary.com/x.jpg" }));
  const b = await adminSaveBox(null, input({ name: "B", imagePublicId: "giftpacific/boxes/x", imageUrl: "https://res.cloudinary.com/x.jpg" }));
  const replaced = await adminSaveBox(a.id, input({ name: "A", imagePublicId: "giftpacific/boxes/y", imageUrl: "https://res.cloudinary.com/y.jpg" }));
  assert.equal(replaced.orphanedPublicId, null); // B still uses x
  assert.equal(await adminDeleteBox(b.id), "giftpacific/boxes/x"); // now nobody does
});

test("move up/down swaps neighbours and ignores the ends", async () => {
  const a = await adminSaveBox(null, input({ name: "A" }));
  const b = await adminSaveBox(null, input({ name: "B" }));
  await adminMoveBox(b.id, "up");
  assert.deepEqual((await getActiveBoxes()).map((x) => x.name), ["B", "A"]);
  await adminMoveBox(b.id, "up");
  assert.deepEqual((await getActiveBoxes()).map((x) => x.name), ["B", "A"]);
  assert.ok(a.id);
});
