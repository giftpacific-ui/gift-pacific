/**
 * Regression: Steadfast answers with HTTP 408 (timeout) or 409 (conflict) were classified as a definite refusal ("rejected": nothing was
 * created), because every 4xx was. Neither proves that. A 408 may still have been processed, and a 409 usually means a parcel for this
 * invoice already exists. Both must be UNCERTAIN so the order is never offered a blind one-click retry.
 * MOCKED transport: these prove OUR classification, not the live API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSteadfastProvider, isSteadfastDefiniteRefusal, STEADFAST_AMBIGUOUS_STATUSES } from "@/lib/courier/steadfast";
import type { HttpResult } from "@/lib/courier/http";
import { getCourierConfig } from "@/lib/courier/config";

const cfg = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY-abcdef", COURIER_API_SECRET: "SEC-123456" });
const req = { reference: "AP-1", recipientName: "A B", recipientPhone: "01711000000", recipientAddress: "H1, Dhaka", codAmount: 100 };
const book = (r: HttpResult) => createSteadfastProvider(cfg, (async () => r) as never).book(req);

test("REGRESSION: HTTP 408 and 409 are uncertain, never a clean rejection", async () => {
  for (const status of [408, 409]) {
    const r = await book({ kind: "http_error", status, json: { message: "whatever" } });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.kind, "uncertain", `HTTP ${status}`);
  }
});

test("the uncertain message says what happened and tells the admin a parcel may exist", async () => {
  const r409 = await book({ kind: "http_error", status: 409, json: { message: "Invoice exists" } });
  assert.ok(!r409.ok && /409/.test(r409.message) && /may already exist/i.test(r409.message) && /Invoice exists/.test(r409.message));
  const r408 = await book({ kind: "http_error", status: 408, json: null });
  assert.ok(!r408.ok && /408/.test(r408.message) && /timed out/i.test(r408.message));
});

test("an HTTP 200 whose BODY says 408 / 409 is just as ambiguous", async () => {
  for (const status of [408, 409]) {
    const r = await book({ kind: "ok", status: 200, json: { status, message: "conflict" } });
    assert.equal(!r.ok && r.kind, "uncertain", `body status ${status}`);
  }
});

test("other 4xx stay definite refusals (validation, auth, not processed) and 5xx stay uncertain", async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    assert.equal(isSteadfastDefiniteRefusal(status), true, String(status));
    const r = await book({ kind: "http_error", status, json: { message: "no" } });
    assert.equal(!r.ok && r.kind, "rejected", `HTTP ${status}`);
  }
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isSteadfastDefiniteRefusal(status), false);
    const r = await book({ kind: "http_error", status, json: null });
    assert.equal(!r.ok && r.kind, "uncertain", `HTTP ${status}`);
  }
  assert.deepEqual([...STEADFAST_AMBIGUOUS_STATUSES], [408, 409]);
});

test("the ambiguous messages still mask credentials", async () => {
  const r = await book({ kind: "http_error", status: 409, json: { message: "dup KEY-abcdef SEC-123456" } });
  assert.ok(!r.ok && !r.message.includes("KEY-abcdef") && !r.message.includes("SEC-123456"));
});

test("a 408 / 409 is still never retried automatically (one request)", async () => {
  let calls = 0;
  const p = createSteadfastProvider(cfg, (async () => { calls++; return { kind: "http_error", status: 409, json: null } as HttpResult; }) as never);
  await p.book(req);
  assert.equal(calls, 1);
});
