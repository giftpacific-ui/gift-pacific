import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import {
  updateOrderStatusAction,
  updateOrderTrackingAction,
  updatePaymentStatusAction,
} from "@/server/actions/admin-order.actions";
import { saveCouponAction } from "@/server/actions/admin-coupon.actions";
import {
  saveVariantAction,
  saveCustomizationFieldAction,
} from "@/server/actions/admin-product.actions";
import {
  uploadImageAction,
  deleteCloudinaryImageAction,
} from "@/server/actions/upload.actions";

let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedAdmins(db); // the actions pass the signed-in admin ("admin-1" in the test stub) to services that re-check it
  db.insert("order", { id: "o1", orderNumber: "AP-1", status: "PENDING" });
  db.insert("product", {
    id: "pv",
    name: "V",
    slug: "v",
    type: "VARIANT",
    status: "DRAFT",
    price: 5,
  });
  db.insert("product", {
    id: "pp",
    name: "P",
    slug: "p",
    type: "PERSONALIZED",
    status: "DRAFT",
    price: 5,
  });
});
const admin = <T>(fn: () => Promise<T>) => runAs("admin", fn);

test("admin actions require an admin session", async () => {
  await assert.rejects(
    runAs(null, () => updateOrderStatusAction("o1", "CONFIRMED")),
    /FORBIDDEN/,
  );
  await assert.rejects(
    runAs({ sub: "cust" }, () =>
      uploadImageAction("data:image/png;base64,AAAA", "products"),
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    runAs({ sub: "cust" }, () => saveCouponAction(null, {})),
    /FORBIDDEN/,
  );
});

test("order status action returns an error result (not a crash) for invalid transitions", async () => {
  const bad = await admin(() => updateOrderStatusAction("o1", "REFUNDED"));
  assert.deepEqual(bad.success, false);
  assert.equal(
    (await admin(() => updateOrderStatusAction("o1", "CONFIRMED"))).success,
    true,
  );
  assert.equal(db.get("order", "o1").status, "CONFIRMED");
});

test("internal errors never leak to the client: unknown order gives a safe message", async () => {
  const res = await admin(() =>
    updateOrderStatusAction("missing", "CONFIRMED"),
  );
  assert.equal(res.success, false);
  assert.ok(!("message" in res) || !/prisma|invocation|P20/i.test(res.message));
});

test("tracking URL must be http(s); a hand-typed payment status is ignored (it is derived from verified payments)", async () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.com",
    "ftp://x",
  ]) {
    assert.equal(
      (await admin(() => updateOrderTrackingAction("o1", { trackingUrl: url })))
        .success,
      false,
      url,
    );
  }
  assert.equal(
    (
      await admin(() =>
        updateOrderTrackingAction("o1", {
          trackingUrl: "https://courier.example/track/1",
        }),
      )
    ).success,
    true,
  );
  // Payment status is DERIVED from verified payments; a typed-in PAID is ignored (an order with no verified money stays UNPAID).
  assert.equal(
    (await admin(() => updatePaymentStatusAction("o1", "PAID"))).success,
    true,
  );
  assert.equal(db.get("order", "o1").paymentStatus, "UNPAID");
});

const coupon = (o = {}) => ({
  code: "save10",
  type: "PERCENTAGE",
  value: 10,
  minPurchase: "",
  maxDiscount: "",
  usageLimit: "",
  perUserLimit: "",
  startsAt: "",
  endsAt: "",
  isActive: true,
  description: "",
  ...o,
});
test("coupon action enforces business rules server-side", async () => {
  const save = (o: object) =>
    admin(() => saveCouponAction(null, coupon(o) as never));
  assert.equal((await save({ value: 150 })).success, false); // % > 100
  assert.equal((await save({ value: 0 })).success, false);
  assert.equal((await save({ value: -4 })).success, false);
  assert.equal(
    (await save({ startsAt: "2026-05-01", endsAt: "2026-04-01" })).success,
    false,
  );
  assert.equal((await save({ startsAt: "garbage" })).success, false);
  assert.equal((await save({ usageLimit: 0 })).success, false);
  assert.equal(
    (await save({ type: "FIXED", value: 50, maxDiscount: 10 })).success,
    false,
  );
  assert.equal(db.rows("coupon").length, 0);
  assert.equal((await save({})).success, true);
  assert.equal(db.rows("coupon")[0].code, "SAVE10");
});

const variant = (o = {}) => ({
  name: "S",
  sku: "V1",
  price: 10,
  optionsJson: '{"Size":"S"}',
  stock: 1,
  image: "",
  allowBackorder: false,
  isDefault: false,
  ...o,
});
test("variant action never trusts the options JSON", async () => {
  for (const optionsJson of [
    "not json",
    "[]",
    "null",
    '{"Size":5}',
    "{}",
    '{"a":{"b":1}}',
  ]) {
    assert.equal(
      (
        await admin(() =>
          saveVariantAction("pv", null, variant({ optionsJson })),
        )
      ).success,
      false,
      optionsJson,
    );
  }
  assert.equal(
    (
      await admin(() =>
        saveVariantAction("pv", null, variant({ image: "javascript:x" })),
      )
    ).success,
    false,
  );
  assert.equal(db.rows("productVariant").length, 0);
  assert.equal(
    (await admin(() => saveVariantAction("pv", null, variant()))).success,
    true,
  );
  assert.deepEqual(db.rows("productVariant")[0].options, { Size: "S" });
});

const field = (o = {}) => ({
  label: "Name",
  fieldKey: "name",
  type: "TEXT",
  isRequired: true,
  optionsCsv: "",
  maxLength: "",
  sortOrder: 0,
  ...o,
});
test("customization field action: IMAGE_UPLOAD is gone; SELECT/COLOR need options", async () => {
  const save = (o: object) =>
    admin(() => saveCustomizationFieldAction("pp", null, field(o) as never));
  assert.equal((await save({ type: "IMAGE_UPLOAD" })).success, false);
  assert.equal((await save({ type: "SELECT", optionsCsv: "" })).success, false);
  assert.equal(
    (await save({ type: "TEXT", optionsCsv: "a,b" })).success,
    false,
  );
  assert.equal(
    (
      await save({
        type: "SELECT",
        optionsCsv: "Gold, Silver",
        fieldKey: "finish",
      })
    ).success,
    true,
  );
  assert.deepEqual(db.rows("productCustomizationField")[0].options, [
    "Gold",
    "Silver",
  ]);
  assert.equal(
    (
      await admin(() =>
        saveCustomizationFieldAction("pv", null, field() as never),
      )
    ).success,
    false,
  ); // not a PERSONALIZED product
});

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]).toString("base64");
test("upload action: only JPEG/PNG/WebP with matching bytes reach Cloudinary", async () => {
  const svg = Buffer.from("<svg onload=alert(1)/>").toString("base64");
  const before = (
    (globalThis as { __TEST_UPLOADS__?: unknown[] }).__TEST_UPLOADS__ ?? []
  ).length;
  assert.equal(
    (
      await admin(() =>
        uploadImageAction(`data:image/svg+xml;base64,${svg}`, "products"),
      )
    ).success,
    false,
  );
  assert.equal(
    (
      await admin(() =>
        uploadImageAction(`data:image/png;base64,${svg}`, "products"),
      )
    ).success,
    false,
  );
  assert.equal(
    (
      await admin(() =>
        uploadImageAction(`data:image/png;base64,${PNG}`, "../etc" as never),
      )
    ).success,
    false,
  );
  assert.equal(
    ((globalThis as { __TEST_UPLOADS__?: unknown[] }).__TEST_UPLOADS__ ?? [])
      .length,
    before,
  );
  assert.equal(
    (
      await admin(() =>
        uploadImageAction(`data:image/png;base64,${PNG}`, "products"),
      )
    ).success,
    true,
  );
  assert.equal(
    (await admin(() => deleteCloudinaryImageAction("somewhere-else/x")))
      .success,
    false,
  );
  assert.equal(
    (await admin(() => deleteCloudinaryImageAction("giftpacific/products/x")))
      .success,
    true,
  );
});

const productForm = (o = {}) => ({
  name: "Plain Pot",
  slug: "plain-pot",
  shortDescription: "",
  description: "<p>Nice</p><script>x()</script>",
  sku: "",
  brand: "",
  type: "STANDARD",
  status: "ACTIVE",
  badges: [],
  categoryId: "",
  price: 500,
  compareAtPrice: "",
  costPrice: "",
  stock: 4,
  lowStockThreshold: 5,
  allowBackorder: false,
  trackInventory: true,
  isFeatured: false,
  videoUrl: "",
  weightGrams: "",
  metaTitle: "",
  metaDescription: "",
  ...o,
});
test("product action: blank optional fields save fine (regression: '' used to coerce to 0); rules enforced", async () => {
  const save = (o: object) =>
    admin(() =>
      import("@/server/actions/admin-product.actions").then((m) =>
        m.saveProductAction(null, productForm(o)),
      ),
    );
  assert.equal((await save({})).success, true);
  const row = db.rows("product").find((p) => p.slug === "plain-pot")!;
  assert.equal(row.compareAtPrice, null);
  assert.equal(row.costPrice, null);
  assert.ok(!String(row.description).includes("<script"));
  assert.equal(
    (await save({ slug: "a1", compareAtPrice: 400 })).success,
    false,
  ); // compare-at below price
  assert.equal(
    (await save({ slug: "a2", compareAtPrice: 500 })).success,
    false,
  ); // equal to price
  assert.equal((await save({ slug: "a3", compareAtPrice: 650 })).success, true);
  assert.equal((await save({ slug: "a4", price: 0 })).success, false);
  assert.equal((await save({ slug: "a5", stock: -3 })).success, false);
  assert.equal(
    (await save({ slug: "a6", videoUrl: "javascript:alert(1)" })).success,
    false,
  );
  assert.equal((await save({ slug: "a7", type: "BUNDLE" })).success, false); // ACTIVE bundle with no components
  assert.equal(
    (await save({ slug: "a8", type: "BUNDLE", status: "DRAFT" })).success,
    true,
  );
});

test("coupon action: blank optional limits mean 'unlimited' (null), not 0", async () => {
  const res = await admin(() =>
    saveCouponAction(null, {
      code: "free5",
      type: "FIXED",
      value: 5,
      minPurchase: "",
      maxDiscount: "",
      usageLimit: "",
      perUserLimit: "",
      startsAt: "",
      endsAt: "",
      isActive: true,
    }),
  );
  assert.equal(res.success, true);
  const c = db.rows("coupon")[0];
  assert.equal(c.usageLimit, null);
  assert.equal(c.perUserLimit, null);
  assert.equal(c.minPurchase, null);
});
