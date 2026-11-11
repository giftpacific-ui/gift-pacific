import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOrderNumber, generateOrderNumber } from "@/lib/order-number";

test("format is human readable: AP-YYYYMM-NNNNNN (Dhaka month)", () => {
  assert.equal(formatOrderNumber(new Date("2026-10-08T10:00:00Z"), 123), "AP-202610-000123");
  // 2026-09-30 19:00 UTC is already October 1st in Dhaka (UTC+6)
  assert.equal(formatOrderNumber(new Date("2026-09-30T19:00:00Z"), 1n), "AP-202610-000001");
  assert.equal(formatOrderNumber(new Date("2026-10-08T10:00:00Z"), 1234567n), "AP-202610-1234567");
});

test("rejects non-positive sequences", () => {
  assert.throws(() => formatOrderNumber(new Date(), 0));
  assert.throws(() => formatOrderNumber(new Date(), -5));
});

test("200 concurrent generations from an atomic sequence are all unique", async () => {
  let seq = 0;
  // Simulates nextval(): atomic increment, but each caller awaits (yields) first.
  const nextval = async () => { await Promise.resolve(); return ++seq; };
  const numbers = await Promise.all(Array.from({ length: 200 }, () => generateOrderNumber(nextval)));
  assert.equal(new Set(numbers).size, 200);
});

test("the old count+1 approach WOULD collide (regression demonstration)", async () => {
  let existing = 0; // number of orders already stored
  const countThenPlusOne = async () => { const count = existing; await Promise.resolve(); return count + 1; };
  const numbers = await Promise.all(Array.from({ length: 5 }, () => countThenPlusOne()));
  assert.ok(new Set(numbers).size < 5, "read-then-compute is racy");
});
