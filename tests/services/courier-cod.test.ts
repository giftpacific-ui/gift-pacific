/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { recordCodEntry } from "@/server/services/courier-cod.service";

/** Courier COD entries: ADMIN-only, COD orders handed to a courier only, duplicates refused, append-only (the service has no update or delete). */
let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedAdmins(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer", role: "CUSTOMER", isActive: true });
  db.insert("order", { id: "o1", orderNumber: "AP-1", status: "DELIVERED", paymentMethod: "COD", total: 1500, advancePaid: 200, courierBookingStatus: "BOOKED", courierProvider: "steadfast" });
  db.insert("order", { id: "o-online", orderNumber: "AP-2", status: "DELIVERED", paymentMethod: "BKASH", total: 1500, advancePaid: 1500, courierBookingStatus: "BOOKED", courierProvider: "steadfast" });
  db.insert("order", { id: "o-nobook", orderNumber: "AP-3", status: "CONFIRMED", paymentMethod: "COD", total: 1500, advancePaid: 0, courierBookingStatus: "NOT_BOOKED", courierProvider: null });
});
const entries = () => db.rows("courierCodEntry");
const collection = (over: Record<string, unknown> = {}) => ({ orderId: "o1", adminId: "a1", kind: "COLLECTION_REPORTED", amount: 1300, reference: "ST-1", note: null, ...over });

test("only an active ADMIN may record a COD entry", async () => {
  for (const adminId of [null, "ghost", "cust-9"]) {
    await assert.rejects(recordCodEntry(collection({ adminId })), /not authorised/i);
  }
  db.patch("user", "a2", { isActive: false });
  await assert.rejects(recordCodEntry(collection({ adminId: "a2" })), /not authorised/i);
  assert.equal(entries().length, 0);
});

test("only COD orders that were handed to a courier accept entries", async () => {
  await assert.rejects(recordCodEntry(collection({ orderId: "o-online" })), /Only cash-on-delivery/i);
  await assert.rejects(recordCodEntry(collection({ orderId: "o-nobook" })), /not been handed to a courier/i);
  await assert.rejects(recordCodEntry(collection({ orderId: "missing" })), /not found/i);
  assert.equal(entries().length, 0);
});

test("a valid entry is stored with its actor and audited; the same kind + reference is refused the second time", async () => {
  await recordCodEntry(collection());
  assert.deepEqual(entries().map((e) => [e.orderId, e.kind, Number(e.amount), e.reference, e.createdById, e.provider]), [["o1", "COLLECTION_REPORTED", 1300, "ST-1", "a1", "steadfast"]]);
  assert.equal(db.rows("adminAuditEvent").filter((e) => e.action === "COURIER_COD_ENTRY").length, 1);
  await assert.rejects(recordCodEntry(collection({ adminId: "a2" })), /already recorded/i);
  assert.equal(entries().length, 1);
  await recordCodEntry(collection({ kind: "SETTLEMENT_RECEIVED", amount: 1300 }));      // another kind with the same reference is a different fact
  assert.equal(entries().length, 2);
});

test("invalid entries are refused before anything is written", async () => {
  await assert.rejects(recordCodEntry(collection({ amount: 0 })), /Enter an amount/i);
  await assert.rejects(recordCodEntry(collection({ kind: "ADJUSTMENT", amount: -5, note: "x" })), /needs a note/i);
  assert.equal(entries().length, 0);
});

test("history is corrected by a new ADJUSTMENT entry, never by editing: the service exposes no update or delete", async () => {
  const mod = await import("@/server/services/courier-cod.service");
  assert.deepEqual(Object.keys(mod).filter((k) => /update|delete|edit|remove/i.test(k)), []);
  await recordCodEntry(collection());
  await recordCodEntry(collection({ kind: "ADJUSTMENT", amount: -100, note: "courier over-reported", reference: null }));
  assert.equal(entries().length, 2);
});
