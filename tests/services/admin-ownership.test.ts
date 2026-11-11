import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import * as svc from "@/server/services/admin-product.service";
import * as actions from "@/server/actions/admin-product.actions";

let db: FakeDb;
const A = "prod-A", B = "prod-B";
beforeEach(() => {
  db = freshDb();
  db.insert("product", { id: A, name: "A", slug: "a", type: "VARIANT", status: "DRAFT", price: 10 });
  db.insert("product", { id: B, name: "B", slug: "b", type: "VARIANT", status: "DRAFT", price: 10 });
  db.insert("productImage", { id: "imgB", productId: B, url: "https://x/b.png", isMain: true });
  db.insert("productImage", { id: "imgB2", productId: B, url: "https://x/b2.png" });
  db.insert("productImage", { id: "imgA", productId: A, url: "https://x/a.png" });
  db.insert("productVariant", { id: "varB", productId: B, sku: "B1", price: 10, stock: 1, options: { Size: "S" }, name: "S" });
  db.insert("productVariant", { id: "varA", productId: A, sku: "A1", price: 10, stock: 1, options: { Size: "S" }, name: "S" });
  db.insert("productCustomizationField", { id: "fldB", productId: B, label: "L", fieldKey: "k", type: "TEXT" });
  db.insert("product", { id: "bundle-A", name: "BA", slug: "ba", type: "BUNDLE", status: "DRAFT", price: 10 });
  db.insert("product", { id: "bundle-B", name: "BB", slug: "bb", type: "BUNDLE", status: "DRAFT", price: 10 });
  db.insert("productBundleItem", { id: "biB", bundleId: "bundle-B", componentId: A, quantity: 1 });
});
const variantInput = (o = {}) => ({ name: "M", sku: "NEW", price: 20, options: { Size: "M" }, stock: 2, allowBackorder: false, isDefault: false, ...o });
const stillThere = (table: string, id: string) => db.rows(table).some((r) => r.id === id);

test("images: Product B's image can't be read/deleted/set-main via Product A", async () => {
  assert.equal(await svc.adminGetProductImage(A, "imgB"), null);
  assert.notEqual(await svc.adminGetProductImage(B, "imgB"), null);
  await assert.rejects(svc.adminDeleteProductImage(A, "imgB"), /not found for this product/);
  await assert.rejects(svc.adminSetMainProductImage(A, "imgB2"), /not found for this product/);
  await assert.rejects(svc.adminReorderProductImages(A, ["imgA", "imgB"]), /not found for this product/);
  assert.ok(stillThere("productImage", "imgB"));
  assert.equal(db.get("productImage", "imgB").isMain, true); // B's main untouched
  assert.equal(db.get("productImage", "imgB2").isMain, false);
  // legit operations on the right parent still work
  await svc.adminSetMainProductImage(B, "imgB2");
  assert.equal(db.get("productImage", "imgB2").isMain, true);
  assert.equal(db.get("productImage", "imgB").isMain, false);
  await svc.adminDeleteProductImage(B, "imgB");
  assert.ok(!stillThere("productImage", "imgB"));
});

test("variants: B's variant can't be updated or deleted through A", async () => {
  await assert.rejects(svc.adminUpdateVariant(A, "varB", variantInput({ options: { Size: "L" } })), /Variant not found/);
  await assert.rejects(svc.adminDeleteVariant(A, "varB"), /Variant not found/);
  assert.equal(db.get("productVariant", "varB").price, 10); // unchanged
  assert.ok(stillThere("productVariant", "varB"));
  await svc.adminUpdateVariant(B, "varB", variantInput({ options: { Size: "L" }, sku: "B1" }));
  assert.equal(db.get("productVariant", "varB").price, 20);
});

test("customization fields: B's field can't be updated or deleted through A", async () => {
  const input = { label: "X", fieldKey: "x", type: "TEXT" as const, isRequired: true, options: [], maxLength: null, sortOrder: 0 };
  await assert.rejects(svc.adminUpdateCustomizationField(A, "fldB", input), /Field not found/);
  await assert.rejects(svc.adminDeleteCustomizationField(A, "fldB"), /Field not found/);
  assert.equal(db.get("productCustomizationField", "fldB").label, "L");
  await svc.adminUpdateCustomizationField(B, "fldB", input);
  assert.equal(db.get("productCustomizationField", "fldB").label, "X");
});

test("bundle items: bundle-B's component row can't be deleted through bundle-A", async () => {
  await assert.rejects(svc.adminDeleteBundleItem("bundle-A", "biB"), /Bundle item not found/);
  assert.ok(stillThere("productBundleItem", "biB"));
  await svc.adminDeleteBundleItem("bundle-B", "biB");
  assert.ok(!stillThere("productBundleItem", "biB"));
});

test("the same checks hold at the SERVER ACTION layer (not just the service)", async () => {
  const run = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
  assert.equal((await run(() => actions.deleteProductImageAction("imgB", A))).success, false);
  assert.equal((await run(() => actions.setMainProductImageAction(A, "imgB2"))).success, false);
  assert.equal((await run(() => actions.deleteVariantAction("varB", A))).success, false);
  assert.equal((await run(() => actions.deleteCustomizationFieldAction("fldB", A))).success, false);
  assert.equal((await run(() => actions.deleteBundleItemAction("biB", "bundle-A"))).success, false);
  assert.ok(stillThere("productImage", "imgB") && stillThere("productVariant", "varB") && stillThere("productBundleItem", "biB"));
  // and non-admins can't call them at all
  await assert.rejects(runAs(null, () => actions.deleteVariantAction("varA", A)), /FORBIDDEN/);
});

test("product type gates: variants only on VARIANT, fields only on PERSONALIZED, components only into BUNDLE", async () => {
  db.insert("product", { id: "std", name: "S", slug: "s", type: "STANDARD", status: "DRAFT", price: 5 });
  await assert.rejects(svc.adminCreateVariant("std", variantInput()), /variant product/);
  await assert.rejects(svc.adminAddCustomizationField("std", { label: "L", fieldKey: "k", type: "TEXT", isRequired: true, options: [], maxLength: null, sortOrder: 0 }), /personalized/);
  await assert.rejects(svc.adminAddBundleItem("std", A, 1), /bundle product/);
  await assert.rejects(svc.adminAddBundleItem("bundle-A", "bundle-A", 1), /itself/);
  await assert.rejects(svc.adminAddBundleItem("bundle-A", "bundle-B", 1), /another bundle/);
  await assert.rejects(svc.adminAddBundleItem("bundle-A", A, 0), /quantity/i);
  await svc.adminAddBundleItem("bundle-A", A, 2);
});

test("variant validation: duplicate combos, inconsistent option names, bad numbers", async () => {
  await assert.rejects(svc.adminCreateVariant(B, variantInput({ options: { size: "s" } })), /already has this exact/);
  await assert.rejects(svc.adminCreateVariant(B, variantInput({ options: { Colour: "Red" } })), /same option names/);
  await assert.rejects(svc.adminCreateVariant(B, variantInput({ price: 0 })), /price/i);
  await assert.rejects(svc.adminCreateVariant(B, variantInput({ stock: -1 })), /stock/i);
  await assert.rejects(svc.adminCreateVariant(B, variantInput({ image: "javascript:alert(1)" })), /image/i);
  await svc.adminCreateVariant(B, variantInput());
});

test("ACTIVE products must keep what their type requires", async () => {
  const base = { name: "N", slug: "n", description: "d", type: "VARIANT" as const, status: "ACTIVE" as const, badges: [], price: 10, stock: 0, lowStockThreshold: 5, allowBackorder: false, trackInventory: true, isFeatured: false };
  await assert.rejects(svc.adminCreateProduct(base, []), /at least one variant/);
  await assert.rejects(svc.adminCreateProduct({ ...base, type: "BUNDLE", slug: "n2" }), /at least one component/);
  await assert.rejects(svc.adminCreateProduct({ ...base, type: "PERSONALIZED", slug: "n3" }), /personalization field/);
  const ok = await svc.adminCreateProduct({ ...base, slug: "n4" }, [{ name: "S", sku: "N4", price: 10, options: { Size: "S" }, stock: 1, allowBackorder: false, isDefault: true }]);
  assert.equal(db.rows("productVariant").filter((v) => v.productId === ok.id).length, 1);
  // can't make B ACTIVE while it... has a variant — fine; but A→ACTIVE after removing variants is blocked
  await svc.adminUpdateProduct(B, { ...base, slug: "b", name: "B" });
  await assert.rejects(svc.adminDeleteVariant(B, "varB"), /last one/); // last child of an ACTIVE product
  await svc.adminUpdateProduct(B, { ...base, slug: "b", name: "B", status: "DRAFT" });
  await svc.adminDeleteVariant(B, "varB");
  await assert.rejects(svc.adminUpdateProduct(B, { ...base, slug: "b", name: "B" }), /at least one variant/);
});

test("create is atomic: a bad draft variant creates no product", async () => {
  const base = { name: "N", slug: "atomic", description: "d", type: "VARIANT" as const, status: "DRAFT" as const, badges: [], price: 10, stock: 0, lowStockThreshold: 5, allowBackorder: false, trackInventory: true, isFeatured: false };
  const v = (o = {}) => ({ name: "S", sku: "AT1", price: 10, options: { Size: "S" }, stock: 1, allowBackorder: false, isDefault: false, ...o });
  await assert.rejects(svc.adminCreateProduct(base, [v(), v({ sku: "AT2" })]), /exact option combination/);
  assert.ok(!db.rows("product").some((p) => p.slug === "atomic"));
  // through the action: a malformed draft variant FAILS the save instead of being silently dropped
  const res = await runAs("admin", () => actions.saveProductAction(null, { ...base, slug: "atomic2", shortDescription: "", sku: "", brand: "", categoryId: "", compareAtPrice: "", costPrice: "", weightGrams: "", videoUrl: "", metaTitle: "", metaDescription: "" }, [{ name: "S", sku: "Z", price: 10, optionsJson: "not json", stock: 1, allowBackorder: false, isDefault: false }]));
  assert.equal(res.success, false);
  assert.ok(!db.rows("product").some((p) => p.slug === "atomic2"));
});

test("images: unsafe URLs are rejected", async () => {
  await assert.rejects(svc.adminAddProductImage(A, "javascript:alert(1)", false), /http/);
  await assert.rejects(svc.adminAddProductImage(A, "data:image/svg+xml;base64,AAAA", false), /http/);
  await svc.adminAddProductImage(A, "https://res.cloudinary.com/x.png", false);
});
