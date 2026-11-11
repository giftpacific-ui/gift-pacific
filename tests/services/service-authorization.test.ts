/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { adjustStock } from "@/server/services/stock-adjustment.service";
import { receiveProcurement } from "@/server/services/procurement.service";
import { recordIncident } from "@/server/services/incident.service";
import { recordSettlement } from "@/server/services/settlement.service";
import { adminUpdateOrderStatus, getOrderByNumberForCurrentUser, placeOrder } from "@/server/services/order.service";
import { bookOrderWithCourier, bulkBookOrders, refreshCourierStatus, saveManualCourier } from "@/server/services/courier.service";
import { addItemToCart } from "@/server/services/cart.service";
import type { ServiceActor } from "@/server/services/advance.service";

/**
 * Sensitive service operations authorise their actor INSIDE the service (not only in the server action):
 * an active ADMIN re-read from the database, or one of the few internal system flows. Everything else is refused BEFORE any validation, lookup or write.
 */
let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedAdmins(db);
  seedCatalog(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
});

const NOT_AUTHORISED = /not authorised/i;
/** Everyone who must be refused: nobody, unknown ids, a customer, a deactivated admin, and a made-up system flow. */
const DENIED: [string, ServiceActor | null | undefined][] = [
  ["no actor", undefined],
  ["null actor", null],
  ["admin id null", { adminId: null }],
  ["unknown id", { adminId: "ghost" }],
  ["CUSTOMER account", { adminId: "cust-9" }],
  ["deactivated ADMIN", { adminId: "adm-off" }],
  ["made-up system flow", { system: "customer-says-so" } as never],
];
const adminIdOf = (a: ServiceActor | null | undefined): string | null => (a && "adminId" in a ? (a.adminId ?? null) : null);

// ---- operations that already take an adminId ------------------------------------------------------------------------------------------
for (const [label, actor] of DENIED) {
  const id = adminIdOf(actor);
  if (actor && "system" in actor) continue; // adminId-style services have no system path at all (covered below)

  test(`stock adjustment refuses: ${label}; stock and ledger are untouched`, async () => {
    const before = db.get("product", "p-standard").stock;
    await assert.rejects(adjustStock({ productId: "p-standard", delta: 1, reason: "valid reason", adminId: id }), NOT_AUTHORISED);
    assert.equal(db.get("product", "p-standard").stock, before);
    assert.equal(db.rows("stockAdjustment").length, 0);
  });

  test(`procurement receipt refuses: ${label}; nothing is received`, async () => {
    const before = db.get("product", "p-standard").stock;
    await assert.rejects(receiveProcurement({ productId: "p-standard", quantity: 1, adminId: id }), NOT_AUTHORISED);
    assert.equal(db.get("product", "p-standard").stock, before);
    assert.equal(db.rows("procurementReceipt").length, 0);
  });

  test(`incident recording refuses: ${label}; authorisation is checked before validation`, async () => {
    await assert.rejects(recordIncident({} as never, id), NOT_AUTHORISED);   // an empty form would otherwise fail validation first
    assert.equal(db.rows("financialIncident").length, 0);
  });

  test(`settlement recording refuses: ${label}`, async () => {
    await assert.rejects(recordSettlement({} as never, id), NOT_AUTHORISED);
    assert.equal(db.rows("marketplaceSettlement").length, 0);
  });
}

test("an active ADMIN may adjust stock and is recorded as the actor", async () => {
  const before = db.get("product", "p-standard").stock as number;
  const r = await adjustStock({ productId: "p-standard", delta: 3, reason: "Restock from supplier", adminId: "a1" });
  assert.equal(r.stockAfter, before + 3);
  assert.deepEqual(db.rows("stockAdjustment").map((x) => x.createdById), ["a1"]);
});

test("an active ADMIN passes the procurement check (validation, not authorisation, then decides)", async () => {
  await assert.rejects(receiveProcurement({ productId: "p-standard", quantity: 0, adminId: "a1" }), (e: any) => !NOT_AUTHORISED.test(String(e?.message)));
  // Whatever the stock rules then say, it must not be an authorisation refusal.
  await receiveProcurement({ productId: "p-standard", quantity: 2, adminId: "a1" }).catch((e: any) => assert.doesNotMatch(String(e?.message), NOT_AUTHORISED));
});

// ---- operations with an explicit ServiceActor -------------------------------------------------------------------------------------------
for (const [label, actor] of DENIED) {
  test(`order status change refuses: ${label}, before looking the order up`, async () => {
    await assert.rejects(adminUpdateOrderStatus("no-such-order", "CONFIRMED", undefined, actor as never), NOT_AUTHORISED);
  });
  test(`courier booking refuses: ${label}, even when no courier is configured`, async () => {
    await assert.rejects(bookOrderWithCourier("no-such-order", { actor: actor as never }, {}), NOT_AUTHORISED);
  });
  test(`bulk courier booking refuses: ${label}`, async () => {
    await assert.rejects(bulkBookOrders(["no-such-order"], {}, { actor: actor as never }), NOT_AUTHORISED);
  });
  test(`courier status refresh refuses: ${label}`, async () => {
    await assert.rejects(refreshCourierStatus("no-such-order", actor as never, {}), NOT_AUTHORISED);
  });
  test(`manual courier details refuse: ${label}, and nothing is written`, async () => {
    await assert.rejects(saveManualCourier("no-such-order", { courierName: "X" }, actor as never), NOT_AUTHORISED);
  });
}

test("an ADMIN actor and the internal courier flows pass the authorisation step (the next error is about the order, not permission)", async () => {
  const notAuth = (e: any) => !NOT_AUTHORISED.test(String(e?.message));
  await assert.rejects(adminUpdateOrderStatus("no-such-order", "CONFIRMED", undefined, { adminId: "a1" }), notAuth);
  await assert.rejects(adminUpdateOrderStatus("no-such-order", "CONFIRMED", undefined, { system: "courier-sync" }), notAuth);
  await assert.rejects(refreshCourierStatus("no-such-order", { system: "courier-reconcile" }, {}), notAuth);
  await assert.rejects(saveManualCourier("no-such-order", { courierName: "X" }, { adminId: "a1" }), notAuth);
});

test("an ambient 'admin' browser session does not authorise anything: the service checks the named actor", async () => {
  await runAs("admin", async () => {
    await assert.rejects(adminUpdateOrderStatus("no-such-order", "CONFIRMED", undefined, { adminId: "cust-9" }), NOT_AUTHORISED);
    await assert.rejects(adjustStock({ productId: "p-standard", delta: 1, reason: "valid reason", adminId: "cust-9" }), NOT_AUTHORISED);
  });
});

test("an admin who is deactivated AFTER the page loaded is refused on the next operation", async () => {
  await adjustStock({ productId: "p-standard", delta: 1, reason: "valid reason", adminId: "a2" });
  db.patch("user", "a2", { isActive: false });
  await assert.rejects(adjustStock({ productId: "p-standard", delta: 1, reason: "valid reason", adminId: "a2" }), NOT_AUTHORISED);
});

// ---- legitimate customer operations stay open ---------------------------------------------------------------------------------------------
test("customer-facing order operations do NOT require an admin: a customer can order and read only their own order", async () => {
  await runAs({ sub: "cust-9" }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const placed: any = await runAs({ sub: "cust-9" }, () => placeOrder(emptyCheckout));
  const number = placed.orderNumber ?? db.rows("order")[0].orderNumber;
  const mine = await runAs({ sub: "cust-9" }, () => getOrderByNumberForCurrentUser(number));
  assert.ok(mine);
  const theirs = await runAs({ sub: "someone-else" }, () => getOrderByNumberForCurrentUser(number));
  assert.equal(theirs, null);                                  // ownership is enforced server-side
  const guest = await runAs(null, () => getOrderByNumberForCurrentUser(number));
  assert.equal(guest, null);
});
