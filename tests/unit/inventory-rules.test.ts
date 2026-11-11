import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLineStockEffect, goodsCanComeBack, outstandingProcurement, physicalOut, planLegacyBackorderLink, planRelease, releaseModeFor, remainingOut, type LineCounters } from "@/lib/inventory-rules";
import { validateIncident } from "@/lib/incident";

const line = (o: Partial<LineCounters> = {}): LineCounters => ({ quantity: 5, stockDeducted: 3, procurementQty: 2, procurementReceivedQty: 1, stockReturnedQty: 0, stockDiscardedQty: 0, ...o });

test("physical accounting: out = deducted + received-from-supplier; units still awaited never existed", () => {
  const l = line();
  assert.deepEqual([physicalOut(l), remainingOut(l), outstandingProcurement(l)], [4, 4, 1]);
  assert.equal(remainingOut(line({ stockReturnedQty: 3, stockDiscardedQty: 1 })), 0);
  assert.equal(remainingOut(line({ stockReturnedQty: 9 })), 0);                      // never negative
  assert.equal(physicalOut(line({ componentPolicy: true, stockDeducted: 0, procurementQty: 0, procurementReceivedQty: 0 })), 5); // combo lines count whole combos
});

test("release mode: goods that never left return automatically; goods that shipped never do", () => {
  for (const s of ["PENDING", "CONFIRMED", "PROCESSING"] as const) assert.equal(releaseModeFor(s), "FULL", s);
  for (const s of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED_DELIVERY", "REFUND_REQUESTED", "REFUNDED"] as const) assert.equal(releaseModeFor(s), "PENDING_ONLY", s);
  assert.deepEqual(planRelease(line(), "FULL"), { backToShelf: 4, releasePending: 1 });
  assert.deepEqual(planRelease(line(), "PENDING_ONLY"), { backToShelf: 0, releasePending: 1 });
});

test("a release never gives back units an earlier incident already restocked or discarded", () => {
  assert.equal(planRelease(line({ stockReturnedQty: 2, stockDiscardedQty: 1 }), "FULL").backToShelf, 1);
  assert.equal(planRelease(line({ stockReturnedQty: 4 }), "FULL").backToShelf, 0);
});

test("incident stock effect: only shipped goods, only units that left stock, only what is still out", () => {
  const shipped = line({ procurementQty: 0, procurementReceivedQty: 0, stockDeducted: 3 });
  assert.equal(checkLineStockEffect("RESTOCK", 3, shipped, "DELIVERED"), null);
  assert.match(checkLineStockEffect("RESTOCK", 1, shipped, "PROCESSING")!, /have not left/);
  assert.match(checkLineStockEffect("RESTOCK", 4, shipped, "DELIVERED")!, /Only 3 units/);
  assert.match(checkLineStockEffect("RESTOCK", 1, line({ stockReturnedQty: 3, procurementQty: 0, procurementReceivedQty: 0 }), "DELIVERED")!, /already back/);
  assert.match(checkLineStockEffect("DISCARD", 1, line({ stockDeducted: 0, procurementQty: 0, procurementReceivedQty: 0 }), "DELIVERED")!, /never took units/);
  assert.equal(checkLineStockEffect("NONE", 99, shipped, "PENDING"), null);
  assert.equal(checkLineStockEffect("WRITE_OFF", 99, shipped, "PENDING"), null);        // write-off is validated elsewhere (not on order lines)
  assert.equal(goodsCanComeBack("FAILED_DELIVERY"), true);
});

test("incident input rules: WRITE_OFF never on an order line; DISCARD only for goods that came back, tied to a line", () => {
  const base = { kind: "CUSTOMER_RETURN", occurredOn: "2026-10-01", quantity: 1, stockEffect: "NONE", lossAmount: 0, refundAmount: 0, courierFee: 0, hasOrderItem: true, hasProduct: true } as never;
  assert.equal(validateIncident({ ...base, stockEffect: "RESTOCK" }), null);
  assert.equal(validateIncident({ ...base, stockEffect: "DISCARD", lossAmount: 40 }), null);
  assert.match(validateIncident({ ...base, stockEffect: "DISCARD", hasOrderItem: false })!, /tied to the order line/);
  assert.match(validateIncident({ ...base, kind: "DAMAGED_BOX", stockEffect: "DISCARD" })!, /Only returned/);
  assert.match(validateIncident({ ...base, kind: "UNSELLABLE_WRITE_OFF", stockEffect: "WRITE_OFF" })!, /already left stock/);
  assert.equal(validateIncident({ ...base, kind: "UNSELLABLE_WRITE_OFF", stockEffect: "WRITE_OFF", hasOrderItem: false }), null);
});

test("legacy backorder plan: newest open lines take the debt first; shipped lines are never candidates; the remainder is reported", () => {
  const c = [{ lineId: "A", orderCreatedAt: 1, stockDeducted: 2 }, { lineId: "B", orderCreatedAt: 2, stockDeducted: 2 }, { lineId: "D", orderCreatedAt: 3, stockDeducted: 1 }];
  assert.deepEqual(planLegacyBackorderLink(3, c), { links: [{ lineId: "D", moveUnits: 1, stockDeductedBefore: 1, stockDeductedAfter: 0 }, { lineId: "B", moveUnits: 2, stockDeductedBefore: 2, stockDeductedAfter: 0 }], residual: 0 });
  assert.deepEqual(planLegacyBackorderLink(2, c).links.map((l) => [l.lineId, l.moveUnits, l.stockDeductedAfter]), [["D", 1, 0], ["B", 1, 1]]);
  assert.deepEqual(planLegacyBackorderLink(9, c).residual, 4);
  assert.deepEqual(planLegacyBackorderLink(0, c), { links: [], residual: 0 });
  assert.deepEqual(planLegacyBackorderLink(5, []), { links: [], residual: 5 });
  const tie = planLegacyBackorderLink(1, [{ lineId: "a", orderCreatedAt: 5, stockDeducted: 1 }, { lineId: "b", orderCreatedAt: 5, stockDeducted: 1 }]);
  assert.equal(tie.links[0].lineId, "b");                                                // deterministic tie-break
});
