/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import {
  approveRefundAttestation,
  refundGatewayTransaction,
  rejectRefundAttestation,
  resolveUncertainGatewayRefund,
  sendNeverSubmittedGatewayRefund,
  syncGatewayRefund,
} from "@/server/services/gateway-payment.service";

/**
 * What these tests prove: OUR refund rules (authorisation, amount limits, duplicate prevention, manual attestation, second-admin approval).
 * What they do NOT prove: how bKash itself behaves. The bKash contract is unverified (third-party documentation only); no test here sends a real
 * or simulated bKash success. Every case below is decided before any network call; `fetch` is replaced by a counter that fails the test if used.
 * Advisory locks are no-ops in the in-memory database, so real concurrency is not proven here.
 */
let db: FakeDb;
let fetchCalls = 0;
const realFetch = globalThis.fetch;
const KEYS = ["BKASH_ENABLED", "BKASH_APP_KEY", "BKASH_APP_SECRET", "BKASH_USERNAME", "BKASH_PASSWORD", "BKASH_ENV", "GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD"];
const saved: Record<string, string | undefined> = {};

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

function configureBkash(on: boolean) {
  if (!on) { for (const k of KEYS) delete process.env[k]; return; }
  Object.assign(process.env, { BKASH_ENABLED: "true", BKASH_APP_KEY: "test-key", BKASH_APP_SECRET: "test-secret", BKASH_USERNAME: "test-user", BKASH_PASSWORD: "test-pass", BKASH_ENV: "sandbox" });
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  configureBkash(false);
  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("network must not be used by these tests"); }) as never;
  db = freshDb();
  seedAdmins(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer", role: "CUSTOMER", isActive: true });
  db.insert("order", { id: "o1", orderNumber: "AP-1001", status: "CANCELLED", userId: null, total: 600, advancePaid: 100, currency: "BDT" });
  db.insert("gatewayTransaction", {
    id: "t1", provider: "BKASH", orderId: "o1", purpose: "ADVANCE", merchantInvoiceNumber: "INV-1", providerPaymentId: "PID1", providerTrxId: "TRX0000001",
    status: "SUCCEEDED", amount: 100, currency: "BDT", environment: "SANDBOX", paymentId: "pay1", expiresAt: ago(-60), createdAt: ago(600), updatedAt: ago(600),
  });
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch;
});

const refundRow = (over: Record<string, unknown> = {}) =>
  db.insert("gatewayRefund", { id: "r1", transactionId: "t1", amount: 100, reason: "customer cancelled", status: "PENDING", idempotencyKey: "key-r1-aaaa", requestedById: "a1", createdAt: ago(60), updatedAt: ago(60), submittedAt: ago(30),
    providerRefundTrxId: null, resolvedById: null, resolvedAt: null, providerConfirmedAt: null, accountingRecordedAt: null, incidentId: null,
    proposedOutcome: null, proposedTrxId: null, proposedConfirmedOn: null, proposedEvidence: null, proposedNote: null, proposedById: null, proposedAt: null, ...over });
const refund = (id = "r1") => db.get("gatewayRefund", id);
const attest = (over: Record<string, unknown> = {}) => ({ refundId: "r1", adminId: "a1", outcome: "NOT_REFUNDED" as const, evidence: "dashboard shot #44", note: "Checked the bKash dashboard: no refund shown.", ...over });
const audits = (action: string) => db.rows("adminAuditEvent").filter((e) => e.action === action);
const refundArgs = (over: Record<string, unknown> = {}) => ({ transactionId: "t1", adminId: "a1", amount: 50, reason: "customer cancelled", idempotencyKey: "idem-key-0001", ...over }) as any;

// ---- authorisation: every refund entry point refuses non-admins BEFORE anything else -----------------------------------------------------
const BAD_ADMIN_IDS: [string, string][] = [["unknown id", "ghost"], ["a CUSTOMER account", "cust-9"]];
for (const [label, id] of BAD_ADMIN_IDS) {
  test(`every refund operation refuses ${label}, even when bKash is not configured`, async () => {
    refundRow();
    await assert.rejects(refundGatewayTransaction(refundArgs({ adminId: id })), /not authorised/i);
    await assert.rejects(sendNeverSubmittedGatewayRefund("r1", id), /not authorised/i);
    await assert.rejects(resolveUncertainGatewayRefund(attest({ adminId: id })), /not authorised/i);
    await assert.rejects(approveRefundAttestation("r1", id), /not authorised/i);
    await assert.rejects(rejectRefundAttestation("r1", id, "not right at all"), /not authorised/i);
    await assert.rejects(syncGatewayRefund("r1", id), /not authorised/i);
    assert.equal(refund().status, "PENDING");
    assert.equal(db.rows("gatewayRefund").length, 1);
    assert.equal(fetchCalls, 0);
  });
}

test("a deactivated admin is refused", async () => {
  refundRow();
  db.patch("user", "a2", { isActive: false });
  await assert.rejects(resolveUncertainGatewayRefund(attest({ adminId: "a2" })), /not authorised/i);
});

// ---- refund request rules (decided before any provider call) -------------------------------------------------------------------------------
test("refund request: input is validated before anything is created", async () => {
  configureBkash(true);
  await assert.rejects(refundGatewayTransaction(refundArgs({ reason: "x" })), /reason/i);
  await assert.rejects(refundGatewayTransaction(refundArgs({ amount: 0 })), /amount/i);
  await assert.rejects(refundGatewayTransaction(refundArgs({ amount: Number.NaN })), /amount/i);
  await assert.rejects(refundGatewayTransaction(refundArgs({ idempotencyKey: "short" })), /Invalid request/i);
  assert.equal(db.rows("gatewayRefund").length, 0);
  assert.equal(fetchCalls, 0);
});

test("refund request: only a payment bKash confirmed, for a cancelled or refund-requested order, can be refunded", async () => {
  configureBkash(true);
  db.patch("gatewayTransaction", "t1", { status: "VERIFYING" });
  await assert.rejects(refundGatewayTransaction(refundArgs()), /confirmed by bKash/i);
  db.patch("gatewayTransaction", "t1", { status: "SUCCEEDED" });
  db.patch("order", "o1", { status: "DELIVERED" });
  await assert.rejects(refundGatewayTransaction(refundArgs()), /cancelled or have a refund request/i);
  await assert.rejects(refundGatewayTransaction(refundArgs({ transactionId: "nope" })), /not found/i);
  assert.equal(db.rows("gatewayRefund").length, 0);
  assert.equal(fetchCalls, 0);
});

test("refund request: the total of all non-failed refunds can never exceed the amount paid", async () => {
  configureBkash(true);
  refundRow({ id: "r-open", amount: 60, idempotencyKey: "key-open-0001" });          // 60 already requested
  await assert.rejects(refundGatewayTransaction(refundArgs({ amount: 50 })), /Only 40\.00 of this payment can still be refunded/);
  db.patch("gatewayRefund", "r-open", { status: "FAILED" });                          // a FAILED refund frees its amount
  // (a valid new request would now reach bKash: not exercised here because the bKash contract is unverified)
  assert.equal(fetchCalls, 0);
});

test("refund request: the same idempotency key returns the existing refund and sends nothing", async () => {
  configureBkash(true);
  refundRow({ id: "r-dup", amount: 50, idempotencyKey: "idem-key-0001", submittedAt: null, createdAt: ago(0) });
  const again = await refundGatewayTransaction(refundArgs());
  assert.equal((again as any).id, "r-dup");
  assert.equal(db.rows("gatewayRefund").length, 1);
  assert.equal(fetchCalls, 0);
});

test("a refund that may already have reached bKash is never sent again", async () => {
  refundRow({ submittedAt: ago(30) });
  await assert.rejects(sendNeverSubmittedGatewayRefund("r1", "a1"), /cannot be sent again|already reached/i);
  refundRow({ id: "r-new", idempotencyKey: "key-new-0001", submittedAt: null, createdAt: ago(0) });
  await assert.rejects(sendNeverSubmittedGatewayRefund("r-new", "a1"), /just created/i);
  refundRow({ id: "r-done", idempotencyKey: "key-done-001", status: "SUCCEEDED" });
  await assert.rejects(sendNeverSubmittedGatewayRefund("r-done", "a1"), /already finished/i);
  assert.equal(fetchCalls, 0);
});

// ---- manual attestation of an uncertain refund -----------------------------------------------------------------------------------------------
test("attestation needs evidence and a note, and cannot be recorded too early or for a refund that was never sent", async () => {
  refundRow();
  await assert.rejects(resolveUncertainGatewayRefund(attest({ evidence: "x" })), /where you saw this/i);
  await assert.rejects(resolveUncertainGatewayRefund(attest({ note: "short" })), /Describe what you checked/i);
  await assert.rejects(resolveUncertainGatewayRefund(attest({ outcome: "MAYBE" as never })), /Choose what the bKash dashboard shows/i);
  await assert.rejects(resolveUncertainGatewayRefund(attest({ outcome: "REFUNDED" })), /refund transaction id/i);
  await assert.rejects(resolveUncertainGatewayRefund(attest({ outcome: "REFUNDED", providerRefundTrxId: "BAD" })), /refund transaction id/i);
  await assert.rejects(resolveUncertainGatewayRefund(attest({ outcome: "REFUNDED", providerRefundTrxId: "RFD123456", confirmedOn: "2999-01-01" })), /between the day the refund was requested and today/i);
  assert.equal(refund().status, "PENDING");

  db.patch("gatewayRefund", "r1", { submittedAt: ago(2) });
  await assert.rejects(resolveUncertainGatewayRefund(attest()), /less than 10 minutes/i);
  db.patch("gatewayRefund", "r1", { submittedAt: null });
  await assert.rejects(resolveUncertainGatewayRefund(attest()), /never sent/i);
  assert.equal(refund().status, "PENDING");
  assert.equal(fetchCalls, 0);
});

test("a valid 'not refunded' attestation settles the refund once, with who, evidence and an audit event; a repeat changes nothing", async () => {
  refundRow();
  const r = await resolveUncertainGatewayRefund(attest());
  assert.equal(r.awaitingApproval, false);
  assert.deepEqual([refund().status, refund().resolvedById, refund().resolutionEvidence, refund().providerStatus], ["FAILED", "a1", "dashboard shot #44", "NOT_REFUNDED_CONFIRMED_BY_ADMIN"]);
  assert.equal(audits("GATEWAY_REFUND_RESOLVED").length, 1);
  const again = await resolveUncertainGatewayRefund(attest({ adminId: "a2" }));
  assert.equal(again.refund.status, "FAILED");
  assert.equal(refund().resolvedById, "a1");                                  // the first decision stands
  assert.equal(audits("GATEWAY_REFUND_RESOLVED").length, 1);
});

// ---- second-admin approval ------------------------------------------------------------------------------------------------------------------
test("above the approval threshold the attestation is only PROPOSED; the proposer cannot approve it; a different admin can", async () => {
  process.env.GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD = "50";
  refundRow({ amount: 100 });
  const r = await resolveUncertainGatewayRefund(attest());
  assert.equal(r.awaitingApproval, true);
  assert.deepEqual([refund().status, refund().proposedById, refund().proposedOutcome], ["PENDING", "a1", "NOT_REFUNDED"]);
  assert.equal(audits("GATEWAY_REFUND_ATTEST_PROPOSED").length, 1);

  await assert.rejects(resolveUncertainGatewayRefund(attest({ adminId: "a2" })), /already waiting for a second admin/i);   // no second proposal on top
  await assert.rejects(approveRefundAttestation("r1", "a1"), /different admin/i);                                         // proposer cannot approve
  assert.equal(refund().status, "PENDING");

  const done = await approveRefundAttestation("r1", "a2");
  assert.deepEqual([done.status, done.resolvedById], ["FAILED", "a2"]);
  assert.equal(refund().proposedById, null);                                                                                // proposal cleared
  assert.equal(audits("GATEWAY_REFUND_RESOLVED").length, 1);
  await assert.rejects(approveRefundAttestation("r1", "a2"), /already settled/i);                                           // cannot be applied twice
});

test("a proposal can be rejected with a reason; the refund stays uncertain and a new decision can be made", async () => {
  process.env.GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD = "50";
  refundRow({ amount: 100 });
  await resolveUncertainGatewayRefund(attest());
  await assert.rejects(rejectRefundAttestation("r1", "a2", "no"), /why the decision is being rejected/i);
  const r = await rejectRefundAttestation("r1", "a2", "Evidence does not match the dashboard");
  assert.deepEqual([r.status, r.proposedById], ["PENDING", null]);
  assert.equal(audits("GATEWAY_REFUND_ATTEST_REJECTED").length, 1);
  await assert.rejects(rejectRefundAttestation("r1", "a2", "Evidence does not match the dashboard"), /no decision waiting/i);
  await assert.rejects(approveRefundAttestation("r1", "a2"), /no decision waiting/i);
});

test("below the threshold (or with the threshold off) one admin can settle it", async () => {
  process.env.GATEWAY_REFUND_ATTESTATION_APPROVAL_THRESHOLD = "500";
  refundRow({ amount: 100 });
  const r = await resolveUncertainGatewayRefund(attest());
  assert.equal(r.awaitingApproval, false);
  assert.equal(refund().status, "FAILED");
});
