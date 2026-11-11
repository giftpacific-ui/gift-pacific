import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { createExternalOrder, adminAddExpense, adminAddOrderCostLine, adminDeleteOrderCostLine, adminSaveChannel, adminListChannels, adminListExpenses } from "@/server/services/external-order.service";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { getChannelReport } from "@/server/services/channel-report.service";
import { bookOrderWithCourier } from "@/server/services/courier.service";
import { getCourierConfig } from "@/lib/courier/config";

let db: FakeDb;
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const stock = (id: string) => db.get("product", id).stock as number;

beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db); // Clay Vase: stock 5, cost 700, price 1800; variant mug (v-red stock ?); Gift Box (legacy OWN_STOCK combo, stock 2)
  db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" });
  db.insert("salesChannel", { id: "channel_daraz", key: "daraz", name: "Daraz", kind: "MARKETPLACE" });
  db.insert("salesChannel", { id: "channel_cartup", key: "cartup", name: "Cartup", kind: "MARKETPLACE" });
  db.insert("salesChannel", { id: "channel_off", key: "old", name: "Old", kind: "MARKETPLACE", isActive: false });
});

const order = (over: Record<string, unknown> = {}) => ({
  channelId: "channel_daraz", externalOrderRef: "d-1001",
  customer: { fullName: "Jo Doe", phone: "01711000000", line1: "House 1, Road 2" },
  items: [{ productId: "p-standard", quantity: 2, unitPrice: 1500 }],
  shippingTotal: 60, ...over,
});

test("records a marketplace order: entered prices, normalised ref, website-style stock deduction recorded per line", async () => {
  const r = await admin(() => createExternalOrder(order({ costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 150 }] }), "admin-1"));
  const o = db.get("order", r.id);
  assert.deepEqual([o.channelId, o.externalOrderRef, o.paymentMethod, o.status, o.paymentStatus, o.email, o.userId, o.createdById], ["channel_daraz", "D-1001", "MARKETPLACE", "CONFIRMED", "PAID", null, null, "admin-1"]);
  assert.equal(Number(o.subtotal), 3000);
  assert.equal(Number(o.total), 3060);
  const [item] = db.rows("orderItem");
  assert.equal(Number(item.unitPrice), 1500);                    // the marketplace price, not the catalogue price (1800)
  assert.equal(Number(item.unitCost), 700);                      // falls back to the catalogue cost; never guessed
  assert.equal(item.stockDeducted, 2);
  assert.equal(stock("p-standard"), 3);
  assert.deepEqual(db.rows("orderCostLine").map((c) => [c.kind, Number(c.amount)]), [["MARKETPLACE_COMMISSION", 150]]);
  assert.equal(db.rows("orderTrackingEvent").length, 1);
});

test("an entered unit cost overrides the catalogue cost; with neither, cost stays unknown (NULL)", async () => {
  db.insert("product", { id: "p-nocost", name: "No Cost", slug: "no-cost", type: "STANDARD", status: "ACTIVE", price: 100, stock: 5, description: "x" });
  await admin(() => createExternalOrder(order({ items: [{ productId: "p-standard", quantity: 1, unitPrice: 1500, unitCost: 650 }, { productId: "p-nocost", quantity: 1, unitPrice: 100 }] }), null));
  const costs = db.rows("orderItem").map((i) => i.unitCost === null ? null : Number(i.unitCost));
  assert.deepEqual(costs, [650, null]);
});

test("NO website side-effects: no cart, coupon, courier booking or analytics path is involved", async () => {
  await admin(() => createExternalOrder(order(), null));
  assert.equal(db.rows("cart").length, 0);
  assert.equal(db.rows("cartItem").length, 0);
  const o = db.rows("order")[0];
  assert.equal(o.couponId ?? null, null);
  assert.equal(o.courierBookingStatus ?? "NOT_BOOKED", "NOT_BOOKED");
  assert.equal(o.courierConsignmentId ?? null, null);
  // Static guard: the service must never import checkout, coupon, analytics, notification or courier code.
  const src = readFileSync(path.join(process.cwd(), "src/server/services/external-order.service.ts"), "utf8");
  for (const forbidden of ["placeOrder", "coupon", "analytics", "trackServerEvent", "courier", "notification", "checkout", "cart.service", "email"]) {
    assert.ok(!new RegExp(`import[^;]*${forbidden}`, "i").test(src), `external-order.service imports ${forbidden}`);
  }
});

test("duplicates are blocked: same channel + reference in any spelling; other channels are independent; a refused order changes nothing", async () => {
  await admin(() => createExternalOrder(order(), null));
  for (const ref of ["D-1001", " d-1001 ", "d 1001".replace(" ", "-")]) {
    await assert.rejects(admin(() => createExternalOrder(order({ externalOrderRef: ref }), null)), /already recorded as AP-/);
  }
  assert.equal(db.rows("order").length, 1);
  assert.equal(stock("p-standard"), 3);                           // the refused attempts took no stock
  await admin(() => createExternalOrder(order({ channelId: "channel_cartup" }), null));   // same ref on another marketplace is a different order
  assert.equal(db.rows("order").length, 2);
});

test("stock policy NONE records nothing as deducted, so a cancellation restores nothing", async () => {
  const r = await admin(() => createExternalOrder(order({ stockPolicy: "NONE" }), null));
  assert.equal(stock("p-standard"), 5);
  assert.equal(db.rows("orderItem")[0].stockDeducted, 0);
  await admin(() => adminUpdateOrderStatus(r.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("p-standard"), 5);
});

test("stock policy DEDUCT: a cancellation restores exactly what was taken, once", async () => {
  const r = await admin(() => createExternalOrder(order(), null));
  assert.equal(stock("p-standard"), 3);
  await admin(() => adminUpdateOrderStatus(r.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("p-standard"), 5);
  await assert.rejects(admin(() => adminUpdateOrderStatus(r.id, "CANCELLED", undefined, TEST_ADMIN)));
  assert.equal(stock("p-standard"), 5);
});

test("insufficient stock refuses the whole order and changes nothing", async () => {
  await assert.rejects(admin(() => createExternalOrder(order({ items: [{ productId: "p-standard", quantity: 9, unitPrice: 1500 }] }), null)), /stock|only/i);
  assert.equal(db.rows("order").length, 0);
  assert.equal(stock("p-standard"), 5);
});

test("variant rules: a variant product needs a valid option; a plain product must not have one", async () => {
  const v = (variantId: unknown, productId = "p-variant") => admin(() => createExternalOrder(order({ items: [{ productId, variantId, quantity: 1, unitPrice: 500 }] }), null));
  await assert.rejects(v(undefined), /Choose an option/);
  await assert.rejects(v("v-ghost"), /Choose an option/);
  await assert.rejects(v("v-red", "p-standard"), /no options/);
  const before = db.get("productVariant", "v-red").stock as number;
  await v("v-red");
  assert.equal(db.get("productVariant", "v-red").stock, before - 1);
});

test("combos: fixed OWN_STOCK uses the box's stock; component-policy combos use component stock", async () => {
  await admin(() => createExternalOrder(order({ externalOrderRef: "BOX-1", items: [{ productId: "p-bundle", quantity: 1, unitPrice: 4000 }] }), null));
  assert.equal(stock("p-bundle"), 1);
  assert.equal(stock("p-standard"), 5);
  assert.equal(db.rows("orderItemComponent")[0].stockDeducted, 0);
  await db.product.update({ where: { id: "p-bundle" }, data: { comboStockPolicy: "COMPONENTS" } });
  await admin(() => createExternalOrder(order({ externalOrderRef: "BOX-2", items: [{ productId: "p-bundle", quantity: 1, unitPrice: 4000 }] }), null));
  assert.equal(stock("p-bundle"), 1);                             // untouched this time
  assert.equal(stock("p-standard"), 3);                           // 2 vases per box
});

test("channel validation: website, inactive and unknown channels are refused; missing products are refused", async () => {
  for (const channelId of ["channel_website", "channel_off", "nope"]) {
    await assert.rejects(admin(() => createExternalOrder(order({ channelId }), null)), /active marketplace/);
  }
  await assert.rejects(admin(() => createExternalOrder(order({ items: [{ productId: "ghost", quantity: 1, unitPrice: 1 }] }), null)), /no longer exists/);
  assert.equal(db.rows("order").length, 0);
});

test("marketplace-fulfilled orders can never be booked with our courier", async () => {
  const r = await admin(() => createExternalOrder(order({ fulfillmentMode: "MARKETPLACE_FULFILLED" }), null));
  const config = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "K", COURIER_API_SECRET: "S", COURIER_WEBHOOK_SECRET: "x".repeat(24) });
  let called = 0;
  const provider = { name: "steadfast", book: async () => { called++; return { ok: false, retryable: false, message: "x" }; } } as never;
  await assert.rejects(admin(() => bookOrderWithCourier(r.id, { actor: TEST_ADMIN }, { provider, config })), /fulfilled by the marketplace/);
  assert.equal(called, 0);
});

test("cost lines: only valid, entered amounts; deletable; scoped to their own order", async () => {
  const a = await admin(() => createExternalOrder(order(), null));
  const b = await admin(() => createExternalOrder(order({ externalOrderRef: "D-2" }), null));
  await adminAddOrderCostLine(a.id, { kind: "COURIER_FEE", amount: 120, note: " steadfast " }, "admin-1");
  assert.equal(db.rows("orderCostLine")[0].note, "steadfast");
  for (const bad of [{ kind: "COURIER_FEE", amount: -1 }, { kind: "COURIER_FEE", amount: NaN }, { kind: "COURIER_FEE", amount: 1.234 }, { kind: "BRIBE", amount: 5 }, { kind: "OTHER", amount: 1e9 }]) {
    await assert.rejects(adminAddOrderCostLine(a.id, bad, null), /./, JSON.stringify(bad));
  }
  await assert.rejects(adminAddOrderCostLine("missing", { kind: "OTHER", amount: 1 }, null), /not found/);
  await adminDeleteOrderCostLine(b.id, db.rows("orderCostLine")[0].id);        // wrong order: no effect
  assert.equal(db.rows("orderCostLine").length, 1);
  await adminDeleteOrderCostLine(a.id, db.rows("orderCostLine")[0].id);
  assert.equal(db.rows("orderCostLine").length, 0);
});

test("channels and expenses: website channel is protected; expenses validated; keys unique", async () => {
  await adminSaveChannel(null, { name: "Facebook Shop", kind: "OTHER", isActive: true });
  await adminSaveChannel(null, { name: "Facebook Shop", kind: "OTHER", isActive: true });
  assert.deepEqual((await adminListChannels()).map((c) => c.key).filter((k) => k.startsWith("facebook")).sort(), ["facebook-shop", "facebook-shop-2"]);
  await assert.rejects(adminSaveChannel("channel_website", { name: "Hacked", kind: "OTHER", isActive: false }), /cannot be edited/);
  await assert.rejects(adminSaveChannel(null, { name: " ", kind: "OTHER", isActive: true }), /required/);
  await adminAddExpense({ spentOn: "2026-10-05", category: " Facebook ads ", amount: 2500.5, channelId: "channel_daraz" });
  for (const bad of [{ spentOn: "2026-13-45", category: "x", amount: 5 }, { spentOn: "2026-10-05", category: " ", amount: 5 }, { spentOn: "2026-10-05", category: "x", amount: 0 }, { spentOn: "2026-10-05", category: "x", amount: 1.234 }, { spentOn: "2026-10-05", category: "x", amount: 5, channelId: "ghost" }]) {
    await assert.rejects(adminAddExpense(bad as never), /./, JSON.stringify(bad));
  }
  const list = await adminListExpenses("2026-10-01", "2026-10-31");
  assert.deepEqual(list.map((e) => [e.category, e.amount]), [["Facebook ads", 2500.5]]);
});

test("channel report end-to-end: website, marketplace and combined are separate; revenue is not profit; marketplace date is used", async () => {
  const today = new Date();
  db.insert("order", { id: "w1", orderNumber: "AP-w1", channelId: "channel_website", status: "DELIVERED", paymentStatus: "PAID", subtotal: 1800, discountTotal: 0, shippingTotal: 70, total: 1870, createdAt: today, phone: "0" });
  db.insert("orderItem", { id: "w1i", orderId: "w1", productId: "p-standard", productName: "Clay Vase", unitPrice: 1800, quantity: 1, lineTotal: 1800, unitCost: 700 });
  const r = await admin(() => createExternalOrder(order({ costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }, { kind: "COURIER_FEE", amount: 60 }] }), null));
  await adminAddExpense({ spentOn: today.toISOString().slice(0, 10), category: "Ads", amount: 200, channelId: null });
  const report = await getChannelReport({});
  const web = report.channels.find((c) => c.kind === "WEBSITE")!;
  const daraz = report.channels.find((c) => c.name === "Daraz")!;
  assert.deepEqual([web.orders, web.revenue, web.productCost, web.profitEstimateBeforeExpenses], [1, 1870, 700, 1170]);
  assert.deepEqual([daraz.orders, daraz.revenue, daraz.productCost, daraz.commissionRecorded, daraz.courierFees], [1, 3060, 1400, 100, 60]);
  assert.equal(daraz.profitEstimateBeforeExpenses, 3060 - 1400 - 100 - 60);
  assert.equal(report.combined.revenue, 1870 + 3060);
  assert.equal(report.combined.expenses, 200);
  assert.equal(report.unassignedExpenses, 200);
  assert.equal(report.combined.netProfitEstimate, report.combined.profitEstimateBeforeExpenses - 200);
  // filter to one channel
  const only = await getChannelReport({ channelId: "channel_daraz" });
  assert.deepEqual([only.channels.length, only.combined.revenue], [1, 3060]);
  // cancelling the marketplace order removes it from revenue and counts it separately
  await admin(() => adminUpdateOrderStatus(r.id, "CANCELLED", undefined, TEST_ADMIN));
  const after = await getChannelReport({});
  assert.deepEqual([after.combined.revenue, after.combined.cancelledOrReturned], [1870, 1]);
});

test("customizable combo: server-validated selections, component stock deducted once, snapshot recorded, cancel restores once", async () => {
  db.insert("product", { id: "p-box", name: "Heart Box", slug: "heart-box", type: "STANDARD", status: "ACTIVE", price: 200, costPrice: 80, stock: 4, description: "x" });
  db.insert("product", { id: "p-custom", name: "Build Your Box", slug: "build", type: "BUNDLE", status: "ACTIVE", price: 1000, stock: 0, description: "x", kind: "COMBO", comboMode: "CUSTOMIZABLE", comboPricing: "FIXED_PRICE", comboStockPolicy: "COMPONENTS" });
  db.insert("comboSlot", { id: "s-box", comboId: "p-custom", label: "Box", minSelect: 1, maxSelect: 1, maxPerOption: 1, sortOrder: 0 });
  db.insert("comboSlot", { id: "s-items", comboId: "p-custom", label: "Items", minSelect: 1, maxSelect: 3, maxPerOption: 2, sortOrder: 1 });
  db.insert("comboSlotOption", { id: "o-box", slotId: "s-box", productId: "p-box", priceDelta: 50, sortOrder: 0 });
  db.insert("comboSlotOption", { id: "o-vase", slotId: "s-items", productId: "p-standard", priceDelta: 0, sortOrder: 1 });
  const sels = [{ slotId: "s-box", optionId: "o-box", quantity: 1 }, { slotId: "s-items", optionId: "o-vase", quantity: 2 }];
  const item = (selections: unknown) => ({ productId: "p-custom", quantity: 2, unitPrice: 1200, selections });
  // Missing / invalid / foreign selections are refused and nothing moves.
  await assert.rejects(admin(() => createExternalOrder(order({ externalOrderRef: "C-1", items: [item(undefined)] }), null)), /Please choose/);
  await assert.rejects(admin(() => createExternalOrder(order({ externalOrderRef: "C-2", items: [item([{ slotId: "s-box", optionId: "o-vase", quantity: 1 }])] }), null)), /not available|choose/);
  assert.equal(db.rows("order").length, 0);
  assert.equal(stock("p-box"), 4);
  await admin(() => createExternalOrder(order({ externalOrderRef: "C-3", items: [item(sels)] }), null));
  assert.equal(stock("p-box"), 4 - 2);        // 1 box x 2 combos
  assert.equal(stock("p-standard"), 5 - 4);   // 2 vases x 2 combos
  assert.equal(stock("p-custom"), 0);
  const [line] = db.rows("orderItem");
  assert.equal((line.comboSnapshot as { mode: string }).mode, "CUSTOMIZABLE");
  assert.equal(db.rows("orderItemComponent").length, 2);
  // Cancelling restores each component exactly once.
  const o = db.rows("order")[0];
  await admin(() => adminUpdateOrderStatus(o.id as string, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("p-box"), 4);
  assert.equal(stock("p-standard"), 5);
  await admin(() => adminUpdateOrderStatus(o.id as string, "CANCELLED", undefined, TEST_ADMIN)).catch(() => undefined);
  assert.equal(stock("p-standard"), 5);
});
