import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIncident, type IncidentInput } from "../../src/lib/incident";

const ok: IncidentInput = { kind: "DAMAGED_BOX", occurredOn: "2026-01-10", quantity: 0, stockEffect: "NONE", lossAmount: 50, refundAmount: 0, courierFee: 0, hasOrderItem: false, hasProduct: false };
const v = (o: Partial<IncidentInput>) => validateIncident({ ...ok, ...o }, new Date("2026-02-01"));

test("valid records pass; money must be explicit and non-negative", () => {
  assert.equal(v({}), null);
  assert.ok(v({ lossAmount: -1 }));
  assert.ok(v({ lossAmount: 1.234 }));
  assert.ok(v({ lossAmount: 0 }), "damage with no cost");
  assert.ok(v({ occurredOn: "2026-13-40" }));
  assert.ok(v({ occurredOn: "2026-03-30" }), "future date");
});
test("restocked goods are never a loss, need the order line, and only returned/undelivered goods can be restocked", () => {
  const restock = { stockEffect: "RESTOCK" as const, kind: "CUSTOMER_RETURN" as const, quantity: 1, hasOrderItem: true, hasProduct: true, lossAmount: 0 };
  assert.equal(v(restock), null);
  assert.match(v({ ...restock, lossAmount: 10 }) ?? "", /not a loss/);
  assert.match(v({ ...restock, hasOrderItem: false }) ?? "", /order line/);
  assert.match(v({ ...restock, kind: "DAMAGED_BOX", lossAmount: 5 }) ?? "", /Only returned/);
  assert.ok(v({ ...restock, quantity: 0 }));
});
test("refund and courier-fee records need their amounts; write-off cannot come from a refund; empty records are refused", () => {
  assert.ok(v({ kind: "REFUND", lossAmount: 0, refundAmount: 0 }));
  assert.equal(v({ kind: "REFUND", lossAmount: 0, refundAmount: 200 }), null);
  assert.ok(v({ kind: "COURIER_RETURN_FEE", lossAmount: 0, courierFee: 0 }));
  assert.ok(v({ kind: "REFUND", refundAmount: 10, lossAmount: 0, stockEffect: "WRITE_OFF", quantity: 1, hasProduct: true }));
  assert.ok(v({ kind: "OTHER", lossAmount: 0 }));
});
