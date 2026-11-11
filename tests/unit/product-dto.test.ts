import { test } from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_PUBLIC_PRODUCT_KEYS, toPublicProductCard, toPublicProductDetail, shortReviewerName } from "@/lib/product-dto";

/** A raw row as it would look if a `select` were widened by mistake: full of internal fields. */
const dec = (n: number) => ({ toNumber: () => n });
const rawVariant = (id: string, price: number, stock: number) => ({
  id, name: id, price: dec(price), options: { Color: id }, image: null, isDefault: false, stock, allowBackorder: false,
  sku: `SECRET-${id}`, costPrice: 1, productId: "p1", createdAt: new Date(), updatedAt: new Date(),
});
const rawDetail = () => ({
  id: "p1", name: "Mug", slug: "mug", shortDescription: null, type: "VARIANT" as const, badges: ["NEW"],
  currency: "BDT", price: dec(650), compareAtPrice: dec(900), videoUrl: null, stock: 999,
  allowBackorder: true, trackInventory: true, description: "<p>ok</p><script>alert(1)</script>",
  sku: "APM-001", images: [{ url: "https://x/y.png", altText: null, id: "img1", productId: "p1", cloudinaryPublicId: "secret" }],
  category: { name: "Clay", slug: "clay", id: "c1", parentId: null, image: null },
  variants: [rawVariant("v1", 650, 0), rawVariant("v2", 700, 3)],
  customizationFields: [
    { label: "Name", fieldKey: "name", type: "TEXT", isRequired: true, options: [], maxLength: 10, id: "f1", productId: "p1", sortOrder: 0 },
    { label: "Photo", fieldKey: "photo", type: "IMAGE_UPLOAD", isRequired: false, options: [], maxLength: null, id: "f2", productId: "p1", sortOrder: 1 },
  ],
  bundleItems: [{ id: "bi1", quantity: 2, bundleId: "p1", componentId: "p2", component: { name: "Vase", costPrice: dec(500), stock: 7, images: [{ url: "https://x/v.png", id: "i" }], sku: "S" } }],
  // internal columns that must never survive mapping:
  costPrice: dec(200), lowStockThreshold: 5, status: "ACTIVE", categoryId: "c1", createdAt: new Date(), updatedAt: new Date(),
  passwordHash: "x",
});

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) { out.add(k); collectKeys(v, out); }
  }
  return out;
}

test("public detail DTO contains none of the internal product fields (deep scan)", () => {
  const dto = toPublicProductDetail(rawDetail() as never);
  const keys = collectKeys(dto);
  for (const forbidden of FORBIDDEN_PUBLIC_PRODUCT_KEYS) {
    assert.equal(keys.has(forbidden), false, `leaked key: ${forbidden}`);
  }
  // No Decimal-like objects: every price is a plain number.
  assert.equal(typeof dto.price, "number");
  assert.equal(typeof dto.variants[0].price, "number");
  // Variant SKUs, bundle component data, internal ids are not exposed.
  assert.equal("sku" in dto.variants[0], false);
  assert.deepEqual(Object.keys(dto.bundleComponents[0]).sort(), ["imageUrl", "name", "quantity"]);
  assert.ok(!JSON.stringify(dto).includes("SECRET"));
  assert.ok(!JSON.stringify(dto).includes("cloudinary"));
  assert.ok(!JSON.stringify(dto).includes("costPrice"));
});

test("serialized DTO survives JSON round trip without internal fields", () => {
  const json = JSON.stringify(toPublicProductDetail(rawDetail() as never));
  for (const word of ["costPrice", "lowStockThreshold", "passwordHash", "allowBackorder", "trackInventory", "categoryId"]) {
    assert.ok(!json.includes(word), word);
  }
});

test("IMAGE_UPLOAD fields are never exposed to the customer form", () => {
  const dto = toPublicProductDetail(rawDetail() as never);
  assert.deepEqual(dto.customizationFields.map((f) => f.fieldKey), ["name"]);
});

test("description is sanitized again at the public boundary", () => {
  const dto = toPublicProductDetail(rawDetail() as never);
  assert.ok(!dto.description.includes("<script"));
  assert.ok(!dto.description.includes("alert(1)"));
});

test("card DTO: variant product availability + price come from VARIANTS, not product stock", () => {
  const raw = rawDetail();
  const card = toPublicProductCard({ ...raw, variants: [{ price: dec(650), stock: 0, allowBackorder: false }, { price: dec(700), stock: 0, allowBackorder: false }] } as never);
  assert.equal(card.availability.inStock, false); // product.stock=999/backorder=true must NOT matter
  const card2 = toPublicProductCard({ ...raw, variants: [{ price: dec(650), stock: 0, allowBackorder: false }, { price: dec(700), stock: 2, allowBackorder: false }] } as never);
  assert.equal(card2.availability.inStock, true);
  assert.equal(card2.price, 700); // lowest PURCHASABLE variant price
  assert.equal(card2.compareAtPrice, 900);
  assert.deepEqual(Object.keys(card2).sort(), ["availability","badges","category","compareAtPrice","comboMode","currency","id","images","kind","name","price","shortDescription","slug","type","videoUrl"].sort());
  assert.deepEqual(card2.category, { name: "Clay", slug: "clay" });
  assert.deepEqual(Object.keys(card2.images[0]).sort(), ["altText", "url"]);
});

test("compareAtPrice only shown when it is above the display price", () => {
  const raw = rawDetail();
  const card = toPublicProductCard({ ...raw, type: "STANDARD", price: dec(1000), compareAtPrice: dec(900), variants: [] } as never);
  assert.equal(card.compareAtPrice, null);
});

test("reviewer names are shortened", () => {
  assert.equal(shortReviewerName("Nusrat Jahan Khan"), "Nusrat K.");
  assert.equal(shortReviewerName("Madonna"), "Madonna");
  assert.equal(shortReviewerName("  "), "Customer");
});
