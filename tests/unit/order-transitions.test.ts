import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_STATUSES, ORDER_STATUS_TRANSITIONS, allowedNextStatuses, assertTransition, canTransition,
  deductionMode, InvalidOrderTransitionError, isTerminalStatus, shouldReleaseStock, type OrderStatusName,
} from "@/lib/order-transitions";

test("the required invalid transitions are rejected", () => {
  const bad: [OrderStatusName, OrderStatusName][] = [
    ["PENDING", "REFUNDED"], ["DELIVERED", "PROCESSING"], ["DELIVERED", "CANCELLED"],
    ["REFUNDED", "DELIVERED"], ["REFUNDED", "PROCESSING"], ["CANCELLED", "PENDING"],
    ["CANCELLED", "CONFIRMED"], ["SHIPPED", "CANCELLED"], ["PENDING", "DELIVERED"], ["PENDING", "PENDING"],
  ];
  for (const [from, to] of bad) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    assert.throws(() => assertTransition(from, to), InvalidOrderTransitionError);
  }
});

test("the normal happy path and refund path are allowed", () => {
  const ok: [OrderStatusName, OrderStatusName][] = [
    ["PENDING", "CONFIRMED"], ["CONFIRMED", "PROCESSING"], ["PROCESSING", "SHIPPED"], ["SHIPPED", "OUT_FOR_DELIVERY"],
    ["OUT_FOR_DELIVERY", "DELIVERED"], ["DELIVERED", "REFUND_REQUESTED"], ["REFUND_REQUESTED", "REFUNDED"],
    ["REFUND_REQUESTED", "DELIVERED"], ["PENDING", "CANCELLED"], ["FAILED_DELIVERY", "OUT_FOR_DELIVERY"], ["FAILED_DELIVERY", "CANCELLED"],
  ];
  for (const [from, to] of ok) assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
});

test("CANCELLED and REFUNDED are terminal; every status is covered by the policy", () => {
  assert.equal(isTerminalStatus("CANCELLED"), true);
  assert.equal(isTerminalStatus("REFUNDED"), true);
  assert.deepEqual(allowedNextStatuses("CANCELLED"), []);
  for (const s of ORDER_STATUSES) assert.ok(s in ORDER_STATUS_TRANSITIONS, s);
  for (const next of Object.values(ORDER_STATUS_TRANSITIONS).flat()) assert.ok(ORDER_STATUSES.includes(next));
});

test("stock is released only when ENTERING a terminal releasing status — never twice", () => {
  // exhaustive: every allowed edge releases at most once, and no edge leaves a releasing status
  let releases = 0;
  for (const from of ORDER_STATUSES) for (const to of allowedNextStatuses(from)) {
    if (shouldReleaseStock(from, to)) releases++;
    assert.equal(shouldReleaseStock(from, to) && ["CANCELLED", "REFUNDED"].includes(from), false);
  }
  assert.ok(releases > 0);
  // no path out of a releasing status => no "consume again" path can exist
  assert.deepEqual(allowedNextStatuses("CANCELLED"), []);
  assert.deepEqual(allowedNextStatuses("REFUNDED"), []);
  assert.equal(shouldReleaseStock("CANCELLED", "REFUNDED"), false);
});

test("deduction modes", () => {
  assert.equal(deductionMode({ trackInventory: false, allowBackorder: false, quantity: 1 }), "skip");
  assert.equal(deductionMode({ trackInventory: false, allowBackorder: true, quantity: 1 }), "skip");
  assert.equal(deductionMode({ trackInventory: true, allowBackorder: false, quantity: 1 }), "guarded");
  assert.equal(deductionMode({ trackInventory: true, allowBackorder: true, quantity: 1 }), "backorder");
});
