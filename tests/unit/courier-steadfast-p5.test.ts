/**
 * Steadfast adapter P5 behaviour against a MOCKED transport. These prove OUR code follows the documented contract (see the evidence note in
 * src/lib/courier/steadfast.ts); they do not prove the live API behaves this way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSteadfastProvider, STEADFAST_STATUSES, parseProviderInstant } from "@/lib/courier/steadfast";
import type { HttpResult } from "@/lib/courier/http";
import { getCourierConfig } from "@/lib/courier/config";

const env = { COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY-abcdef", COURIER_API_SECRET: "SEC-123456" };
const cfg = getCourierConfig(env);
const cfgLookup = getCourierConfig({ ...env, STEADFAST_INVOICE_LOOKUP: "true" });
const req = { reference: "GP-1001", recipientName: "Jo Doe", recipientPhone: "01711000000", recipientAddress: "House 1, Road 2, Dhaka", codAmount: 1500 };

function mock(results: HttpResult[], c = cfg) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: unknown } }[] = [];
  const logs: { action: string; outcome: string; extra: Record<string, unknown> }[] = [];
  const request = (async (url: string, init: never) => { calls.push({ url, init }); return results[Math.min(calls.length - 1, results.length - 1)]; }) as never;
  return { calls, logs, provider: createSteadfastProvider(c, request, (action, outcome, extra) => logs.push({ action, outcome, extra })) };
}
const created = (extra: Record<string, unknown> = {}) => ({ kind: "ok", status: 200, json: { status: 200, message: "ok", consignment: { consignment_id: 77, invoice: "GP-1001", tracking_code: "TRK77", cod_amount: 1500, status: "in_review", ...extra } } }) as HttpResult;

test("booking is refused LOCALLY (nothing sent) for input the courier would certainly refuse", async () => {
  for (const bad of [{ recipientPhone: "12345" }, { recipientPhone: "+8801711000000" }, { recipientName: " " }, { recipientAddress: "" }, { codAmount: -1 }, { codAmount: Number.NaN }, { reference: " " }]) {
    const m = mock([created()]);
    const r = await m.provider.book({ ...req, ...bad });
    assert.deepEqual([r.ok, !r.ok && r.kind], [false, "rejected"], JSON.stringify(bad));
    assert.equal(m.calls.length, 0);
  }
});

test("booking: documented request shape; a timeout is NEVER retried (no idempotency key)", async () => {
  const m = mock([{ kind: "network", message: "The courier did not answer in time." }, created()]);
  const r = await m.provider.book(req);
  assert.deepEqual([r.ok, !r.ok && r.kind], [false, "uncertain"]);
  assert.equal(m.calls.length, 1);
  assert.ok(m.calls[0].url.endsWith("/create_order"));
  assert.deepEqual(Object.keys(m.calls[0].init.body as object).sort(), ["cod_amount", "invoice", "recipient_address", "recipient_name", "recipient_phone"]);
  assert.equal(m.calls[0].init.headers["Secret-Key"], "SEC-123456");
});

test("booking response validation: id required, invoice must match, COD echo captured, soft failures are not 'booked'", async () => {
  const ok = await mock([created()]).provider.book(req);
  assert.deepEqual(ok, { ok: true, consignmentId: "77", trackingCode: "TRK77", trackingUrl: null, providerStatus: "in_review", codAmount: 1500 });
  const other = await mock([created({ invoice: "GP-9999" })]).provider.book(req);
  assert.deepEqual([other.ok, !other.ok && other.kind], [false, "uncertain"]);
  for (const json of [{ status: 200, consignment: {} }, { status: 200 }, { message: "x" }, { status: 422, message: "bad phone" }]) {
    const r = await mock([{ kind: "ok", status: 200, json }]).provider.book(req);
    assert.equal(r.ok, false);
  }
  const rej = await mock([{ kind: "ok", status: 200, json: { status: 422, message: "bad" } }]).provider.book(req);
  assert.equal(!rej.ok && rej.kind, "rejected");
});

test("every documented status is recognised; the vocabulary has no pickup / in-transit / out-for-delivery state", () => {
  assert.equal(STEADFAST_STATUSES.length, 11);
  assert.ok(!STEADFAST_STATUSES.some((s) => /pick|transit|out_for/.test(s)));
});

test("webhook inspection: malformed vs ignored vs event; only zone-carrying times are trusted", () => {
  const { provider } = mock([]);
  const ins = provider.inspectWebhook!;
  for (const bad of [null, "x", 5, [], {}, { status: "delivered" }, { consignment_id: 1 }, { consignment_id: 1, status: "x".repeat(65) }, { consignment_id: "9".repeat(65), status: "delivered" }]) {
    assert.equal(ins(bad).kind, "malformed", JSON.stringify(bad));
  }
  assert.equal(ins({ notification_type: "tracking_update", consignment_id: 1, status: "x" }).kind, "ignored");
  assert.equal(ins({ notification_type: "delivery_status", consignment_id: 1, status: "Delivered" }).kind, "event");
  const withTime = ins({ consignment_id: 5, invoice: "GP-1", status: "Delivered", cod_amount: "1500.00", updated_at: "2026-11-20T10:00:00Z" });
  assert.ok(withTime.kind === "event" && withTime.event.codAmount === 1500 && withTime.event.providerEventAt?.toISOString() === "2026-11-20T10:00:00.000Z");
  const zoneless = ins({ consignment_id: 5, status: "delivered", updated_at: "2026-11-20 10:00:00" });
  assert.ok(zoneless.kind === "event" && !zoneless.event.providerEventAt);
  const future = ins({ consignment_id: 5, status: "delivered", updated_at: "2099-01-01T00:00:00Z" });
  assert.ok(future.kind === "event" && !future.event.providerEventAt);
  assert.equal(parseProviderInstant("not a date"), null);
  const noAmount = ins({ consignment_id: 5, status: "delivered", cod_amount: "abc" });
  assert.ok(noAmount.kind === "event" && noAmount.event.codAmount === undefined);
});

test("connection check: read-only, reports auth/unreachable/unexpected, never exposes the balance", async () => {
  assert.deepEqual(await mock([{ kind: "ok", status: 200, json: { status: 200, current_balance: 4820 } }]).provider.checkConnection!(), { ok: true });
  const a = await mock([{ kind: "http_error", status: 401, json: null }]).provider.checkConnection!();
  assert.deepEqual([a.ok, !a.ok && a.kind], [false, "auth"]);
  const b = await mock([{ kind: "ok", status: 200, json: { status: 401, message: "no" } }]).provider.checkConnection!();
  assert.equal(!b.ok && b.kind, "auth");
  const net = mock([{ kind: "network", message: "Could not reach the courier." }]);
  const c = await net.provider.checkConnection!();
  assert.deepEqual([!c.ok && c.kind, net.calls.length], ["unreachable", 2]); // read-only: one retry
  const d = await mock([{ kind: "ok", status: 200, json: { hello: 1 } }]).provider.checkConnection!();
  assert.equal(!d.ok && d.kind, "unexpected");
  const m = mock([{ kind: "ok", status: 200, json: { status: 200, current_balance: 4820 } }]);
  await m.provider.checkConnection!();
  assert.ok(!JSON.stringify(m.logs).includes("4820"));
  assert.ok(m.calls[0].url.endsWith("/get_balance") && m.calls[0].init.method === "GET");
});

test("reference lookup: OFF by default (no request); only a positive answer is 'found'; everything else is 'unknown', never 'absent'", async () => {
  const off = mock([created()]);
  assert.equal((await off.provider.lookupByReference!("GP-1001")).kind, "unknown");
  assert.equal(off.calls.length, 0);
  assert.equal(off.provider.features?.referenceLookup, false);

  const on = mock([{ kind: "ok", status: 200, json: { status: 200, delivery_status: "in_review" } }], cfgLookup);
  assert.deepEqual(await on.provider.lookupByReference!("GP-1001"), { kind: "found", status: "in_review" });
  assert.ok(on.calls[0].url.endsWith("/status_by_invoice/GP-1001") && on.provider.features?.referenceLookup === true);

  for (const r of [
    { kind: "http_error", status: 404, json: { message: "not found" } },
    { kind: "ok", status: 200, json: { status: 404, message: "not found" } },
    { kind: "ok", status: 200, json: { status: 200 } },
    { kind: "network", message: "x" },
    { kind: "invalid_response", status: 200 },
  ] as HttpResult[]) {
    assert.equal((await mock([r], cfgLookup).provider.lookupByReference!("GP-1001")).kind, "unknown");
  }
  const unsafe = mock([created()], cfgLookup);
  assert.equal((await unsafe.provider.lookupByReference!("GP/../x?y")).kind, "unknown");
  assert.equal(unsafe.calls.length, 0);
});

test("config: invoice lookup is off unless STEADFAST_INVOICE_LOOKUP=true", () => {
  assert.equal(cfg.invoiceLookup, false);
  assert.equal(cfgLookup.invoiceLookup, true);
  assert.equal(getCourierConfig({ ...env, STEADFAST_INVOICE_LOOKUP: "yes" }).invoiceLookup, false);
});

test("request logs carry provider/action/outcome/status/duration/our order number - never secrets or customer data", async () => {
  const m = mock([created()]);
  await m.provider.book({ ...req, recipientName: "Secret Person", recipientAddress: "Hidden Lane 9" });
  await mock([{ kind: "network", message: "x" }]).provider.fetchStatus!("77");
  const dump = JSON.stringify(m.logs);
  for (const forbidden of ["KEY-abcdef", "SEC-123456", "Secret Person", "Hidden Lane", "01711000000", "Api-Key", "Secret-Key"]) assert.ok(!dump.includes(forbidden), forbidden);
  assert.deepEqual(Object.keys(m.logs[0].extra).sort(), ["action", "durationMs", "httpStatus", "outcome", "provider", "reference"]);
  assert.equal(m.logs[0].extra.reference, "GP-1001");
});
