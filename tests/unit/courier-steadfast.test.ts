/**
 * These tests verify OUR adapter code against a MOCKED transport that
 * follows the contract the adapter assumes (see the UNVERIFIED note in
 * src/lib/courier/steadfast.ts). They do NOT prove the live Steadfast API
 * behaves this way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import { requestJson, type HttpResult } from "@/lib/courier/http";
import { getCourierConfig } from "@/lib/courier/config";

const cfg = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY-abcdef", COURIER_API_SECRET: "SEC-123456" });
const req = { reference: "AP-202610-000001", recipientName: "A B", recipientPhone: "01711000000", recipientAddress: "H1, Dhaka", codAmount: 1870, itemDescription: "Vase x1" };

function mock(results: HttpResult[]) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: unknown } }[] = [];
  const request = (async (url: string, init: never) => { calls.push({ url, init }); return results[Math.min(calls.length - 1, results.length - 1)]; }) as never;
  return { calls, provider: createSteadfastProvider(cfg, request) };
}

test("booking success: sends credentials in headers only, never in the body/URL", async () => {
  const { calls, provider } = mock([{ kind: "ok", status: 200, json: { status: 200, message: "ok", consignment: { consignment_id: 4455, tracking_code: "TRK9", status: "in_review" } } }]);
  const r = await provider.book(req);
  assert.deepEqual(r, { ok: true, consignmentId: "4455", trackingCode: "TRK9", trackingUrl: null, providerStatus: "in_review" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["Api-Key"], "KEY-abcdef");
  const sent = JSON.stringify(calls[0].init.body);
  assert.ok(!sent.includes("KEY-abcdef") && !sent.includes("SEC-123456") && !calls[0].url.includes("KEY"));
  assert.equal((calls[0].init.body as Record<string, unknown>).invoice, "AP-202610-000001");
  assert.equal((calls[0].init.body as Record<string, unknown>).cod_amount, 1870);
});

test("booking failure classes: 4xx = rejected, 5xx/network/unreadable = uncertain", async () => {
  const cases: [HttpResult, string][] = [
    [{ kind: "http_error", status: 422, json: { message: "invalid phone KEY-abcdef" } }, "rejected"],
    [{ kind: "http_error", status: 401, json: null }, "rejected"],
    [{ kind: "http_error", status: 500, json: null }, "uncertain"],
    [{ kind: "http_error", status: 503, json: { message: "down" } }, "uncertain"],
    [{ kind: "network", message: "The courier did not answer in time." }, "uncertain"],
    [{ kind: "invalid_response", status: 200 }, "uncertain"],
    [{ kind: "ok", status: 200, json: { status: 200 } }, "uncertain"], // 200 but no consignment
    [{ kind: "ok", status: 200, json: { status: 400, message: "bad" } }, "rejected"],
    [{ kind: "ok", status: 200, json: ["weird"] }, "uncertain"],
  ];
  for (const [result, kind] of cases) {
    const r = await mock([result]).provider.book(req);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.kind, kind, JSON.stringify(result));
    assert.ok(!(!r.ok && r.message.includes("KEY-abcdef")), "credentials masked in messages");
  }
});

test("booking is NEVER retried automatically (one request per call)", async () => {
  const { calls, provider } = mock([{ kind: "network", message: "x" }]);
  await provider.book(req);
  assert.equal(calls.length, 1);
});

test("status fetch retries once on network failure (read-only), then reports failure", async () => {
  const a = mock([{ kind: "network", message: "x" }, { kind: "ok", status: 200, json: { status: 200, delivery_status: "delivered" } }]);
  assert.deepEqual(await a.provider.fetchStatus!("4455"), { ok: true, status: "delivered" });
  assert.equal(a.calls.length, 2);
  const b = mock([{ kind: "network", message: "x" }]);
  assert.equal((await b.provider.fetchStatus!("4455")).ok, false);
  assert.equal(b.calls.length, 2);
  const c = mock([{ kind: "ok", status: 200, json: { status: 200 } }]);
  assert.equal((await c.provider.fetchStatus!("4455")).ok, false);
  assert.ok(c.calls[0].url.endsWith("/status_by_cid/4455"));
});

test("webhook parsing and status mapping", () => {
  const { provider } = mock([]);
  assert.deepEqual(provider.parseWebhook({ notification_type: "delivery_status", consignment_id: 4455, invoice: "AP-1", status: "Delivered" }), { consignmentId: "4455", reference: "AP-1", status: "delivered" });
  assert.equal(provider.parseWebhook({ notification_type: "tracking_update", status: "x" }), null);
  assert.equal(provider.parseWebhook({ consignment_id: 1 }), null);
  for (const bad of [null, "str", 5, []]) assert.equal(provider.parseWebhook(bad), null);
  const m = (s: string) => provider.mapStatus(s);
  assert.equal(m("delivered"), "DELIVERED");
  assert.equal(m("DELIVERED"), "DELIVERED");
  assert.equal(m("in_review"), "PENDING");
  assert.equal(m("cancelled"), "RETURNED");
  assert.equal(m("something_new"), "UNKNOWN");
});

test("requestJson: hard timeout aborts a hanging request; oversized/invalid bodies are not trusted", async () => {
  const hanging = ((_u: string, init: { signal: AbortSignal }) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as never;
  const t0 = Date.now();
  const r = await requestJson("https://x.example", { method: "GET", headers: {} }, 60, hanging);
  assert.equal(r.kind, "network");
  assert.ok(Date.now() - t0 < 1000);
  const res = (status: number, text: string) => (async () => new Response(text, { status })) as never;
  assert.equal((await requestJson("https://x", { method: "GET", headers: {} }, 500, res(200, "<html>"))).kind, "invalid_response");
  assert.equal((await requestJson("https://x", { method: "GET", headers: {} }, 500, res(200, "x".repeat(70000)))).kind, "invalid_response");
  assert.equal((await requestJson("https://x", { method: "GET", headers: {} }, 500, res(500, "oops"))).kind, "http_error");
  assert.equal((await requestJson("https://x", { method: "GET", headers: {} }, 500, res(200, '{"a":1}'))).kind, "ok");
});
