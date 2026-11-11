import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart, getCurrentCartDTO, updateCartItemQuantity } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { restoreOrderStock } from "@/server/services/order-inventory";
import { prisma } from "@/lib/db/prisma";

let db: FakeDb;
const guest = <T,>(fn: () => Promise<T>) => runAs(null, fn);
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const stock = (table: string, id: string) => db.get(table, id).stock as number;
const sel = (slotId: string, optionId: string, quantity = 1) => ({ slotId, optionId, quantity });

beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db); // p-standard "Clay Vase" 1800 (cost 700, stock 5); mug variants; p-bundle = legacy OWN_STOCK gift box (stock 2)
  db.insert("product", { id: "p-box", name: "Heart Box", slug: "heart-box", type: "STANDARD", status: "ACTIVE", price: 200, costPrice: 80, stock: 4, description: "A heart shaped box" });
  db.insert("product", {
    id: "p-custom", name: "Build Your Box", slug: "build-your-box", type: "BUNDLE", status: "ACTIVE", price: 1000, stock: 0, description: "Make your own box",
    kind: "COMBO", comboMode: "CUSTOMIZABLE", comboPricing: "FIXED_PRICE", comboStockPolicy: "COMPONENTS",
  });
  db.insert("comboSlot", { id: "s-box", comboId: "p-custom", label: "Box", minSelect: 1, maxSelect: 1, maxPerOption: 1, sortOrder: 0 });
  db.insert("comboSlot", { id: "s-items", comboId: "p-custom", label: "Items", minSelect: 1, maxSelect: 3, maxPerOption: 2, sortOrder: 1 });
  db.insert("comboSlotOption", { id: "o-box", slotId: "s-box", productId: "p-box", priceDelta: 50, sortOrder: 0 });
  db.insert("comboSlotOption", { id: "o-vase", slotId: "s-items", productId: "p-standard", priceDelta: 0, sortOrder: 0 });
  db.insert("comboSlotOption", { id: "o-mug", slotId: "s-items", productId: "p-variant", variantId: "v-red", priceDelta: 0, sortOrder: 1 });
});

const vaseCombo = (qty = 1, vase = 2) =>
  addItemToCart({ productId: "p-custom", quantity: qty, selections: [sel("s-box", "o-box"), sel("s-items", "o-vase", vase)] });

test("customizable combo: only COMPONENT stock moves; combo stock untouched; snapshot + cost recorded", () => guest(async () => {
  await vaseCombo(2, 2);
  const order = await placeOrder(emptyCheckout);
  assert.equal(stock("product", "p-box"), 4 - 2);          // 1 box x 2 combos
  assert.equal(stock("product", "p-standard"), 5 - 4);     // 2 vases x 2 combos
  assert.equal(stock("product", "p-custom"), 0);           // the combo itself has no stock to move
  const [item] = db.rows("orderItem");
  assert.equal(item.stockDeducted, 0);                     // never BOTH inventories
  assert.equal(Number(item.unitPrice), 1050);              // 1000 + box surcharge 50, decided on the server
  assert.equal(Number(item.unitCost), 80 + 2 * 700);       // sum of known component costs
  assert.equal(Number(order.subtotal), 2100);
  const comps = db.rows("orderItemComponent");
  assert.deepEqual(comps.map((c) => [c.productName, c.quantity, c.stockDeducted]).sort(), [["Clay Vase", 2, 4], ["Heart Box", 1, 2]]);
  assert.equal(item.comboSnapshot.mode, "CUSTOMIZABLE");
  assert.equal(item.comboSnapshot.components.length, 2);
  assert.equal(db.rows("cartItem").length, 0);
  assert.equal(db.rows("cartItemSelection").length, 2);    // fake keeps orphan rows; real DB cascades with the cart item
}));

test("the client cannot choose the price or the components: only ids and quantities are read", () => guest(async () => {
  const cart = await addItemToCart({ productId: "p-custom", quantity: 1, selections: [{ ...sel("s-box", "o-box"), price: 1, productId: "p-variant" }, sel("s-items", "o-vase")] } as never);
  assert.equal(cart.items[0].unitPrice, 1050);
  assert.deepEqual(cart.items[0].components?.map((c) => c.name), ["Heart Box", "Clay Vase"]);
}));

test("invalid selections never reach the cart", () => guest(async () => {
  for (const bad of [undefined, [], [sel("s-box", "o-box")], [sel("s-box", "o-vase"), sel("s-items", "o-vase")], [sel("s-box", "o-box"), sel("s-items", "o-vase", 3)], [sel("s-box", "o-box"), sel("s-items", "ghost")]]) {
    await assert.rejects(addItemToCart({ productId: "p-custom", quantity: 1, selections: bad as never }));
  }
  await assert.rejects(addItemToCart({ productId: "p-custom", variantId: "v-red", quantity: 1, selections: [sel("s-box", "o-box"), sel("s-items", "o-vase")] }));
  assert.equal(db.rows("cartItem").length, 0);
}));

test("identical selections merge into one line; different selections stay separate", () => guest(async () => {
  await vaseCombo(1, 1);
  let cart = await addItemToCart({ productId: "p-custom", quantity: 1, selections: [sel("s-items", "o-vase"), sel("s-box", "o-box")] }); // same, different order
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 2);
  cart = await addItemToCart({ productId: "p-custom", quantity: 1, selections: [sel("s-box", "o-box"), sel("s-items", "o-mug")] });
  assert.equal(cart.items.length, 2);
}));

test("oversell is refused: the box has 4, so a 5th combo cannot be added or checked out", () => guest(async () => {
  await vaseCombo(2, 1); // 2 boxes, 2 vases
  await assert.rejects(updateCartItemQuantity(db.rows("cartItem")[0].id, 5), /left in stock|out of stock/);
  const cart = await updateCartItemQuantity(db.rows("cartItem")[0].id, 4);
  assert.equal(cart.items[0].quantity, 4);
  await assert.rejects(addItemToCart({ productId: "p-custom", quantity: 1, selections: [sel("s-box", "o-box"), sel("s-items", "o-vase")] }), /Heart Box/);
  assert.equal(stock("product", "p-box"), 4);
}));

test("a component shared by two lines is checked against its real stock ONCE (6 needed > 5 in stock)", () => guest(async () => {
  await vaseCombo(2, 2);                                   // 4 vases
  await assert.rejects(addItemToCart({ productId: "p-custom", quantity: 1, selections: [sel("s-box", "o-box"), sel("s-items", "o-vase", 2)] }), /Clay Vase/);  // would need 6
  await vaseCombo(1, 1);                                   // 1 more vase = 5, fits (different selection => separate line)
  assert.equal(db.rows("cartItem").length, 2);
  await placeOrder(emptyCheckout);
  assert.equal(stock("product", "p-standard"), 0);
  assert.equal(stock("product", "p-box"), 4 - 3);
}));

test("a component that is also in the cart as a single product counts together", () => guest(async () => {
  await addItemToCart({ productId: "p-standard", quantity: 2 });
  await assert.rejects(vaseCombo(2, 2), /Clay Vase/);      // 2 single + 4 in combos = 6 > 5
  await vaseCombo(1, 2);                                   // 2 + 2 = 4 <= 5
  await assert.rejects(updateCartItemQuantity(db.rows("cartItem").find((c) => c.productId === "p-standard")!.id, 4), /Clay Vase/);
}));

test("stale cart: stock drops after adding => checkout refuses and NOTHING changes", () => guest(async () => {
  await vaseCombo(2, 2);
  await db.product.update({ where: { id: "p-standard" }, data: { stock: 3 } });
  await assert.rejects(placeOrder(emptyCheckout), /Clay Vase/);
  assert.equal(db.rows("order").length, 0);
  assert.equal(stock("product", "p-box"), 4);
  assert.equal(stock("product", "p-standard"), 3);
  assert.equal(db.rows("cartItem").length, 1);
}));

test("a deactivated component makes the combo unavailable (cart shows why; checkout refuses); reactivating restores it", () => guest(async () => {
  await vaseCombo(1, 1);
  await db.product.update({ where: { id: "p-box" }, data: { status: "ARCHIVED" } });
  const cart = await getCurrentCartDTO();
  assert.equal(cart.items[0].inStock, false);
  assert.match(cart.items[0].unavailableReason ?? "", /no longer available/);
  await assert.rejects(placeOrder(emptyCheckout), /no longer available/);
  await db.product.update({ where: { id: "p-box" }, data: { status: "ACTIVE" } });
  await placeOrder(emptyCheckout);
}));

test("cancel restores component stock exactly once, even if restore runs again or concurrently", () => guest(async () => {
  await vaseCombo(2, 2);
  const order = await placeOrder(emptyCheckout);
  assert.equal(stock("product", "p-standard"), 1);
  await admin(() => adminUpdateOrderStatus(order.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("product", "p-standard"), 5);
  assert.equal(stock("product", "p-box"), 4);
  await assert.rejects(admin(() => adminUpdateOrderStatus(order.id, "CANCELLED", undefined, TEST_ADMIN)));                       // terminal
  const again = await Promise.all([1, 2, 3].map(() => prisma.$transaction((tx) => restoreOrderStock(tx, order.id))));
  assert.deepEqual(again, [0, 0, 0]);
  assert.equal(stock("product", "p-standard"), 5);
  assert.equal(stock("product", "p-box"), 4);
  assert.ok(db.rows("orderItemComponent").every((c) => c.stockRestoredAt !== null));
}));

test("order snapshots are immutable: editing or removing the template/components afterwards changes nothing", () => guest(async () => {
  await vaseCombo(1, 2);
  const order = await placeOrder(emptyCheckout);
  const before = JSON.stringify([db.rows("orderItem"), db.rows("orderItemComponent")]);
  await db.product.update({ where: { id: "p-standard" }, data: { name: "Renamed", price: 9999 } });
  await db.comboSlotOption.deleteMany({ where: { slotId: "s-items" } });
  await db.comboSlot.deleteMany({ where: { id: "s-items" } });
  await db.product.update({ where: { id: "p-custom" }, data: { price: 5 } });
  assert.equal(JSON.stringify([db.rows("orderItem"), db.rows("orderItemComponent")]), before);
  assert.equal(Number(db.rows("orderItem")[0].unitPrice), 1050);
  assert.equal(order.id, db.rows("order")[0].id);
}));

test("fixed OWN_STOCK combo (legacy gift box): only the box's own stock moves, components are descriptive, restore is symmetric", () => guest(async () => {
  await addItemToCart({ productId: "p-bundle", quantity: 1 });
  const order = await placeOrder(emptyCheckout);
  assert.equal(stock("product", "p-bundle"), 1);
  assert.equal(stock("product", "p-standard"), 5);          // component NOT consumed
  const [item] = db.rows("orderItem");
  assert.equal(item.stockDeducted, 1);
  assert.equal(Number(item.unitPrice), 4500);
  assert.equal(db.rows("orderItemComponent").length, 1);    // contents recorded for the order
  assert.equal(db.rows("orderItemComponent")[0].stockDeducted, 0);
  await admin(() => adminUpdateOrderStatus(order.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("product", "p-bundle"), 2);
  assert.equal(stock("product", "p-standard"), 5);
}));

test("fixed combo switched to COMPONENTS policy consumes component stock, not its own", () => guest(async () => {
  await db.product.update({ where: { id: "p-bundle" }, data: { comboStockPolicy: "COMPONENTS" } });
  await addItemToCart({ productId: "p-bundle", quantity: 2 });   // bundle needs 2 vases per box
  const order = await placeOrder(emptyCheckout);
  assert.equal(stock("product", "p-standard"), 5 - 4);
  assert.equal(stock("product", "p-bundle"), 2);
  assert.equal(db.rows("orderItem")[0].stockDeducted, 0);
  await admin(() => adminUpdateOrderStatus(order.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("product", "p-standard"), 5);
}));

test("single-product orders now also record their unit cost (history for profit reports)", () => guest(async () => {
  await addItemToCart({ productId: "p-standard", quantity: 1 });
  await placeOrder(emptyCheckout);
  assert.equal(Number(db.rows("orderItem")[0].unitCost), 700);
}));
