import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedCod, summarizeCod, validateCodEntry } from "../../src/lib/courier/cod-reconciliation";
import { remainingBalance } from "../../src/lib/advance-policy";

const cod = (total: number, advancePaid: number) => expectedCod({ paymentMethod: "COD", total, advancePaid });

test("COD = order total minus verified advance (never negative, never for non-COD orders)", () => {
  assert.equal(cod(1500, 200), 1300);
  assert.equal(cod(1500, 0), 1500);
  assert.equal(cod(1500, 1500), 0);
  assert.equal(cod(1500, 1600), 0);                                              // an over-paid advance never produces negative COD
  assert.equal(expectedCod({ paymentMethod: "BKASH", total: 1500, advancePaid: 0 }), 0);
  assert.equal(expectedCod({ paymentMethod: "COD", total: 1500, advancePaid: null }), 1500);
  assert.equal(cod(10.3, 0.1), 10.2);                                            // decimal fractions are computed in cents, not floating point
  assert.equal(cod(0.3, 0.1), 0.2);
});

test("the courier COD expectation and the order balance use the same calculation", () => {
  for (const total of [0, 1, 99.99, 150.5, 1000, 2499.95, 100000]) {
    for (const advance of [0, 0.01, 50, 100.1, 200, 999.99, 5000]) {
      assert.equal(cod(total, advance), remainingBalance(total, advance), `total ${total}, advance ${advance}`);
    }
  }
});

test("reconciliation: exact collection, fee and settlement leave nothing outstanding and no flags", () => {
  const s = summarizeCod(1300, true, [{ kind: "COLLECTION_REPORTED", amount: 1300 }, { kind: "FEE_DEDUCTED", amount: 100 }, { kind: "SETTLEMENT_RECEIVED", amount: 1200 }]);
  assert.deepEqual([s.collected, s.fees, s.settled, s.outstanding, s.flags], [1300, 100, 1200, 0, []]);
});

test("reconciliation flags: no report, short, excess, settlement outstanding, over-settled", () => {
  const codes = (e: { kind: string; amount: number }[], delivered = true, expected = 1300) => summarizeCod(expected, delivered, e).flags.map((f) => f.code);
  assert.deepEqual(codes([]), ["NO_REPORT"]);
  assert.deepEqual(codes([], false), []);                                         // not delivered yet: nothing to report
  assert.deepEqual(codes([], true, 0), []);                                       // nothing was due (advance covered the order)
  assert.deepEqual(codes([{ kind: "COLLECTION_REPORTED", amount: 1000 }, { kind: "SETTLEMENT_RECEIVED", amount: 1000 }]), ["SHORT_COLLECTION"]);
  assert.deepEqual(codes([{ kind: "COLLECTION_REPORTED", amount: 1400 }, { kind: "SETTLEMENT_RECEIVED", amount: 1400 }]), ["EXCESS_COLLECTION"]);
  assert.deepEqual(codes([{ kind: "COLLECTION_REPORTED", amount: 1300 }]), ["MISSING_SETTLEMENT"]);
  assert.deepEqual(codes([{ kind: "COLLECTION_REPORTED", amount: 1300 }, { kind: "SETTLEMENT_RECEIVED", amount: 1400 }]), ["OVER_SETTLED"]);
  const adj = summarizeCod(1300, true, [{ kind: "COLLECTION_REPORTED", amount: 1200 }, { kind: "ADJUSTMENT", amount: 100 }, { kind: "SETTLEMENT_RECEIVED", amount: 1300 }]);
  assert.deepEqual([adj.collected, adj.outstanding, adj.flags], [1300, 0, []]);   // a corrective adjustment is a new entry, history is never rewritten
});

test("a COD entry is validated: kind, amount, decimals, sign, size, and a note for adjustments", () => {
  const bad = (i: object) => validateCodEntry({ kind: "COLLECTION_REPORTED", amount: 100, ...i });
  assert.equal(bad({ kind: "NOPE" }).ok, false);
  assert.equal(bad({ amount: 0 }).ok, false);
  assert.equal(bad({ amount: "abc" }).ok, false);
  assert.equal(bad({ amount: 10.123 }).ok, false);
  assert.equal(bad({ amount: -5 }).ok, false);                                    // only an adjustment may be negative
  assert.equal(bad({ amount: 10_000_001 }).ok, false);
  assert.equal(validateCodEntry({ kind: "ADJUSTMENT", amount: -50, note: "x" }).ok, false);
  assert.deepEqual(validateCodEntry({ kind: "ADJUSTMENT", amount: -50, note: "courier typo fixed" }), { ok: true, kind: "ADJUSTMENT", amount: -50, reference: null, note: "courier typo fixed" });
  assert.deepEqual(validateCodEntry({ kind: "COLLECTION_REPORTED", amount: "1300.50", reference: "  ST-77 " }), { ok: true, kind: "COLLECTION_REPORTED", amount: 1300.5, reference: "ST-77", note: null });
});
