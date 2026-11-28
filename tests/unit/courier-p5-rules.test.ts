/** P5 pure rules: event precedence, dedupe keys, booking readiness, COD reconciliation / remittance / resolution. No I/O. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEventPrecedence, eventDedupeKey, computeBookingReadiness } from "@/lib/courier/sync-rules";
import { checkBookingEligibility, planOrderTransitions } from "@/lib/courier/status";
import { collectionConfirmable, reconcileCod, splitFlags, validateCodResolution, resolutionKey } from "@/lib/courier/cod-reconciliation";
import { statusMapperFor } from "@/lib/courier";
import { mapSteadfastStatus, steadfastStatusRank } from "@/lib/courier/steadfast";

const rank = steadfastStatusRank;
const T = (s: string) => new Date(s);

test("precedence: first status applies; repeat is a duplicate", () => {
  assert.equal(decideEventPrecedence({ rawStatus: null, eventAt: null }, { rawStatus: "pending", eventAt: null }, rank).decision, "apply");
  assert.equal(decideEventPrecedence({ rawStatus: "pending", eventAt: null }, { rawStatus: "pending", eventAt: null }, rank).decision, "duplicate");
});

test("precedence: an OLDER provider time never overwrites a newer one, a NEWER time may even lower the rank (provider reverted)", () => {
  const prev = { rawStatus: "delivered", eventAt: T("2026-11-20T10:00:00Z") };
  assert.equal(decideEventPrecedence(prev, { rawStatus: "pending", eventAt: T("2026-11-20T09:00:00Z") }, rank).decision, "stale");
  const approval = { rawStatus: "delivered_approval_pending", eventAt: T("2026-11-20T10:00:00Z") };
  assert.equal(decideEventPrecedence(approval, { rawStatus: "pending", eventAt: T("2026-11-20T11:00:00Z") }, rank).decision, "apply");
});

test("precedence: the TIMESTAMP alone rejects an older event even when its rank is HIGHER than the stored one", () => {
  const stored = { rawStatus: "pending", eventAt: T("2026-11-20T12:00:00Z") };
  assert.equal(decideEventPrecedence(stored, { rawStatus: "delivered", eventAt: T("2026-11-20T09:00:00Z") }, rank).decision, "stale");
  assert.equal(decideEventPrecedence(stored, { rawStatus: "delivered", eventAt: T("2026-11-20T13:00:00Z") }, rank).decision, "apply");
});

test("precedence without timestamps: rank decides; lower or unrankable never overrides higher", () => {
  const delivered = { rawStatus: "delivered", eventAt: null };
  assert.equal(decideEventPrecedence(delivered, { rawStatus: "pending", eventAt: null }, rank).decision, "stale");
  assert.equal(decideEventPrecedence(delivered, { rawStatus: "unknown", eventAt: null }, rank).decision, "stale");
  assert.equal(decideEventPrecedence(delivered, { rawStatus: "something_new", eventAt: null }, rank).decision, "stale");
  assert.equal(decideEventPrecedence({ rawStatus: "delivered_approval_pending", eventAt: null }, { rawStatus: "something_new", eventAt: null }, rank).decision, "stale");
  // a status the provider adds later is not hidden behind an in-progress one
  assert.equal(decideEventPrecedence({ rawStatus: "in_review", eventAt: null }, { rawStatus: "picked_up", eventAt: null }, rank).decision, "apply");
  assert.equal(decideEventPrecedence({ rawStatus: "pending", eventAt: null }, { rawStatus: "picked_up", eventAt: null }, rank).decision, "apply");
  assert.equal(decideEventPrecedence({ rawStatus: "pending", eventAt: null }, { rawStatus: "delivered", eventAt: null }, rank).decision, "apply");
  assert.equal(decideEventPrecedence({ rawStatus: "pending", eventAt: null }, { rawStatus: "hold", eventAt: null }, rank).decision, "apply"); // equal rank
  // a timestamped stored event vs an untimestamped poll: rank still protects it
  assert.equal(decideEventPrecedence({ rawStatus: "delivered", eventAt: T("2026-11-20T10:00:00Z") }, { rawStatus: "in_review", eventAt: null }, rank).decision, "stale");
});

test("dedupe key exists only for a trusted provider time", () => {
  assert.equal(eventDedupeKey("steadfast", "C1", "delivered", null), null);
  const k = eventDedupeKey("steadfast", "C1", "delivered", T("2026-11-20T10:00:00Z"));
  assert.equal(k, "steadfast:C1:delivered:2026-11-20T10:00:00.000Z");
  assert.notEqual(k, eventDedupeKey("steadfast", "C1", "delivered", T("2026-11-20T10:00:01Z")));
});

test("readiness lists EVERY blocker; soft (confirmable) vs hard", () => {
  const now = new Date();
  const bad = checkBookingEligibility({ status: "PENDING", paymentMethod: "COD", paymentStatus: "UNPAID", total: 100, courierBookingStatus: "NOT_BOOKED", courierBookingStartedAt: null, recipient: null }, now);
  const r = computeBookingReadiness({ eligibility: bad, gateReason: "advance outstanding", procurementOutstanding: 2, marketplaceFulfilled: false, apiAvailable: false, apiProblem: "Not configured.", remoteConfirmed: false });
  assert.deepEqual(r.blockers.map((b) => b.code), ["provider_unavailable", "not_bookable_status", "dispatch_gate", "procurement"]);
  assert.equal(r.canBook, false);

  const unc = checkBookingEligibility({ status: "CONFIRMED", paymentMethod: "COD", paymentStatus: "UNPAID", total: 100, courierBookingStatus: "UNCERTAIN", courierBookingStartedAt: null, recipient: { name: "Jo Doe", phone: "01711000000", address: "House 1, Dhaka" } }, now);
  const soft = computeBookingReadiness({ eligibility: unc, gateReason: null, procurementOutstanding: 0, marketplaceFulfilled: false, apiAvailable: true, apiProblem: null, remoteConfirmed: false });
  assert.deepEqual([soft.canBook, soft.needsConfirmation], [true, true]); // an admin can clear it
  const hard = computeBookingReadiness({ eligibility: unc, gateReason: null, procurementOutstanding: 0, marketplaceFulfilled: false, apiAvailable: true, apiProblem: null, remoteConfirmed: true });
  assert.equal(hard.canBook, false); // the courier confirmed a parcel exists: no confirmation can clear it
  assert.ok(hard.blockers.some((b) => b.code === "remote_confirmed" && !b.soft));
});

test("order planning: partial delivery never moves the order; cancelled/failed only walk a shipped order to FAILED_DELIVERY; never CANCELLED", () => {
  assert.deepEqual(planOrderTransitions("SHIPPED", "PARTIAL_DELIVERED"), []);
  assert.deepEqual(planOrderTransitions("CONFIRMED", "PARTIAL_DELIVERED"), []);
  assert.deepEqual(planOrderTransitions("SHIPPED", "CANCELLED"), ["FAILED_DELIVERY"]);
  assert.deepEqual(planOrderTransitions("CONFIRMED", "CANCELLED"), []);
  for (const e of ["PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "PARTIAL_DELIVERED", "DELIVERY_FAILED", "RETURNED", "CANCELLED", "UNKNOWN"] as const) {
    for (const s of ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] as const) {
      assert.ok(!planOrderTransitions(s, e).some((x) => ["CANCELLED", "REFUNDED", "REFUND_REQUESTED"].includes(x)));
    }
  }
});

test("Steadfast vocabulary: every documented status maps; partial is its own event; ranks and finality", () => {
  const expected: Record<string, string> = {
    in_review: "PENDING", pending: "PENDING", hold: "PENDING", delivered_approval_pending: "DELIVERED", delivered: "DELIVERED",
    partial_delivered_approval_pending: "PARTIAL_DELIVERED", partial_delivered: "PARTIAL_DELIVERED",
    cancelled_approval_pending: "CANCELLED", cancelled: "CANCELLED", unknown_approval_pending: "UNKNOWN", unknown: "UNKNOWN",
  };
  for (const [raw, ev] of Object.entries(expected)) assert.equal(mapSteadfastStatus(raw), ev, raw);
  assert.equal(mapSteadfastStatus("brand_new_status"), "UNKNOWN");
  const m = statusMapperFor("steadfast")!;
  assert.ok(m.isFinal("delivered") && m.isFinal("cancelled") && m.isFinal("partial_delivered"));
  assert.ok(!m.isFinal("delivered_approval_pending") && !m.isFinal("pending"));
  assert.equal(statusMapperFor("pathao"), null); // no adapter, no guessed vocabulary
});

// ---- COD ----
const base = { expected: 1000, orderDelivered: true, paymentRecorded: false, courierCodAmount: null, partialDelivery: false, entries: [] as { kind: string; amount: unknown }[], resolutions: [] as { flagCode: string; amount: unknown }[] };

test("COD: expected vs courier-held amount, short, excess, missing remittance", () => {
  const mismatch = reconcileCod({ ...base, courierCodAmount: 900 });
  assert.ok(mismatch.flags.some((f) => f.code === "BOOKED_AMOUNT_MISMATCH" && f.amount === 100));
  const short = reconcileCod({ ...base, entries: [{ kind: "COLLECTION_REPORTED", amount: 900 }] });
  assert.ok(short.flags.some((f) => f.code === "SHORT_COLLECTION" && f.amount === 100));
  assert.equal(short.status, "DISCREPANCY");
  const excess = reconcileCod({ ...base, entries: [{ kind: "COLLECTION_REPORTED", amount: 1100 }] });
  assert.ok(excess.flags.some((f) => f.code === "EXCESS_COLLECTION" && f.amount === 100));
  const missing = reconcileCod({ ...base, paymentRecorded: true, entries: [{ kind: "COLLECTION_REPORTED", amount: 1000 }] });
  assert.ok(missing.flags.some((f) => f.code === "MISSING_SETTLEMENT" && f.amount === 1000));
  assert.equal(missing.status, "REPORTED");
});

test("COD: delivered without a recorded payment is 'to be confirmed', never settled or paid", () => {
  const r = reconcileCod(base);
  assert.ok(r.flags.some((f) => f.code === "COLLECTION_UNCONFIRMED"));
  assert.equal(r.status, "AWAITING_CONFIRMATION");
  assert.equal(reconcileCod({ ...base, orderDelivered: false }).status, "NOT_DUE");
});

test("COD: remittance lifecycle reported -> partly settled -> settled", () => {
  const rep = { kind: "COLLECTION_REPORTED", amount: 1000 };
  assert.equal(reconcileCod({ ...base, paymentRecorded: true, entries: [rep] }).status, "REPORTED");
  assert.equal(reconcileCod({ ...base, paymentRecorded: true, entries: [rep, { kind: "SETTLEMENT_RECEIVED", amount: 400 }] }).status, "PARTIALLY_SETTLED");
  assert.equal(reconcileCod({ ...base, paymentRecorded: true, entries: [rep, { kind: "FEE_DEDUCTED", amount: 100 }, { kind: "SETTLEMENT_RECEIVED", amount: 900 }] }).status, "SETTLED");
});

test("COD: a resolution closes exactly that flag and amount; a changed amount re-opens it", () => {
  const entries = [{ kind: "COLLECTION_REPORTED", amount: 900 }];
  const open = reconcileCod({ ...base, paymentRecorded: true, entries });
  const short = open.flags.find((f) => f.code === "SHORT_COLLECTION")!;
  const closed = reconcileCod({ ...base, paymentRecorded: true, entries, resolutions: [{ flagCode: "SHORT_COLLECTION", amount: short.amount }] });
  assert.ok(!closed.flags.some((f) => f.code === "SHORT_COLLECTION"));
  assert.equal(closed.resolvedFlags.length >= 1, true);
  const changed = reconcileCod({ ...base, paymentRecorded: true, entries: [{ kind: "COLLECTION_REPORTED", amount: 800 }], resolutions: [{ flagCode: "SHORT_COLLECTION", amount: short.amount }] });
  assert.ok(changed.flags.some((f) => f.code === "SHORT_COLLECTION" && f.amount === 200));
  assert.equal(resolutionKey("X", 1.1), "X:110");
  assert.deepEqual(splitFlags([{ code: "OVER_SETTLED", amount: 5 }], []).open.length, 1);
});

test("COD resolution validation: reason mandatory, only resolvable flags, known actions", () => {
  assert.equal(validateCodResolution({ flagCode: "SHORT_COLLECTION", action: "WRITTEN_OFF", reason: "short" }).ok, false);
  assert.equal(validateCodResolution({ flagCode: "COLLECTION_UNCONFIRMED", action: "WRITTEN_OFF", reason: "long enough reason" }).ok, false);
  assert.equal(validateCodResolution({ flagCode: "SHORT_COLLECTION", action: "DELETE_IT", reason: "long enough reason" }).ok, false);
  assert.equal(validateCodResolution({ flagCode: "SHORT_COLLECTION", action: "WRITTEN_OFF", reason: "courier deducted agreed discount" }).ok, true);
});

test("collection can't be confirmed while a short collection or partial delivery is open", () => {
  assert.equal(collectionConfirmable([]).ok, true);
  assert.equal(collectionConfirmable([{ code: "SHORT_COLLECTION", amount: 1 }]).ok, false);
  assert.equal(collectionConfirmable([{ code: "PARTIAL_DELIVERY", amount: 0 }]).ok, false);
  assert.equal(collectionConfirmable([{ code: "EXCESS_COLLECTION", amount: 1 }]).ok, true);
});
