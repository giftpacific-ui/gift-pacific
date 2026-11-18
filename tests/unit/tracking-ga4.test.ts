import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  buildOrderAttributionRecord, gaClientIdFromCookie, gaSessionCookieName, gaSessionIdFromCookie,
} from "@/lib/analytics/attribution";
import { CONSENT_REF_COOKIE, generateConsentRef, isValidConsentRef } from "@/lib/analytics/consent-ref";
import { buildGa4PurchasePayload, resolveGa4Config, resolveGa4MeasurementId, sendGa4Purchase } from "@/lib/analytics/ga4-mp";
import { purchaseEvent, type PurchaseInput } from "@/lib/analytics/payloads";
import { GA4_MAX_EVENT_AGE_MS, META_MAX_EVENT_AGE_MS, isEventTooOld, maxEventAgeMs } from "@/lib/analytics/purchase-policy";
import { describeTrackingConfig } from "@/server/services/tracking-diagnostics.service";

const NOW = 1_800_000_000_000;
const SECRET = "ga4-api-secret-VALUE-1234567890";
const cfg = { measurementId: "G-ABCD1234", apiSecret: SECRET, debug: false };

test("GA client id: only the real _ga shape is accepted, from the two numeric parts; junk is dropped, never repaired", () => {
  assert.equal(gaClientIdFromCookie("GA1.1.1234567890.1700000000"), "1234567890.1700000000");
  assert.equal(gaClientIdFromCookie("GA1.2.987654321.1699999999"), "987654321.1699999999");
  assert.equal(gaClientIdFromCookie("GA1.1.1234567890.1700000000.extra"), "1234567890.1700000000");
  for (const bad of [undefined, "", "GA1.1", "GA1.1.abc.1700000000", "XX1.1.1234567890.1700000000", "GA1.1.1234567890.17", "GA1.1.1234567890.1700000000".padEnd(80, "0"), "GA1.1.<script>.1700000000", "1234567890.1700000000", "GA1.1.1234567890;DROP.1700000000"]) {
    assert.equal(gaClientIdFromCookie(bad as never), undefined, String(bad));
  }
});

test("GA session id: GS1 and GS2 cookie formats, nothing else", () => {
  assert.equal(gaSessionIdFromCookie("GS1.1.1700000000.3.1.1700000100.60.0.0"), "1700000000");
  assert.equal(gaSessionIdFromCookie("GS2.1.s1700000000$o3$g1$t1700000100$j60$l0$h0"), "1700000000");
  for (const bad of [undefined, "", "GS1.1.abc.3", "GS2.1.s12$o3", "junk", "GS1.1.1700000000", "x".repeat(300)]) assert.equal(gaSessionIdFromCookie(bad as never), undefined, String(bad));
  assert.equal(gaSessionCookieName("G-ABCD1234"), "_ga_ABCD1234");
});

test("consent reference: 128 random bits, URL-safe, validated; it carries nothing about the person", () => {
  const ref = generateConsentRef((b) => { for (let i = 0; i < b.length; i++) b[i] = (i * 17 + 3) % 256; });
  assert.match(ref, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(isValidConsentRef(ref), true);
  assert.equal(CONSENT_REF_COOKIE, "gp_cref");
  for (const bad of [undefined, null, "", "short", "has space in it aaaaaaaaaaaa", "a".repeat(80), "bad/chars+++++++++++++++", 42]) assert.equal(isValidConsentRef(bad), false, String(bad));
  // Two draws differ (sanity: the generator really uses its entropy source).
  const a = generateConsentRef((b) => void crypto.getRandomValues(b));
  const b = generateConsentRef((x) => void crypto.getRandomValues(x));
  assert.notEqual(a, b);
});

test("order snapshot: GA ids + consent reference are stored only when consent permits, and validated", () => {
  const ref = "R".repeat(22);
  const base = { gaCookie: "GA1.1.1234567890.1700000000", gaSessionCookie: "GS1.1.1700000000.3.1.1700000100.60.0.0", consentRefCookie: ref, ip: "203.0.113.7", userAgent: "UA", now: NOW };
  const granted = buildOrderAttributionRecord({ ...base, consentState: "GRANTED" });
  assert.equal(granted.gaClientId, "1234567890.1700000000");
  assert.equal(granted.gaSessionId, "1700000000");
  assert.equal(granted.consentRef, ref);
  for (const state of ["UNKNOWN", "DENIED"] as const) {
    const r = buildOrderAttributionRecord({ ...base, consentState: state });
    assert.deepEqual([r.gaClientId, r.gaSessionId, r.consentRef, r.clientIp], [null, null, null, null], state);
  }
  const forged = buildOrderAttributionRecord({ ...base, consentState: "GRANTED", gaCookie: "GA1.1.evil.1", consentRefCookie: "not valid!" });
  assert.deepEqual([forged.gaClientId, forged.consentRef], [null, null]);
});

test("GA4 config: explicit id wins, else the storefront's own G- id; a GTM id is NOT a measurement id; the secret is required", () => {
  assert.deepEqual(resolveGa4MeasurementId("G-STORE123", { GA4_MEASUREMENT_ID: "g-explicit9" }), { ok: true, id: "G-EXPLICIT9" });
  assert.deepEqual(resolveGa4MeasurementId("G-STORE123", {}), { ok: true, id: "G-STORE123" });
  assert.deepEqual(resolveGa4MeasurementId(null, { NEXT_PUBLIC_GTM_ID: "G-FROMENV1" }), { ok: true, id: "G-FROMENV1" });
  assert.deepEqual(resolveGa4MeasurementId("GTM-ABCD12", {}), { ok: false, reason: "no_measurement_id" });
  assert.deepEqual(resolveGa4MeasurementId("GTM-ABCD12", { GA4_MEASUREMENT_ID: "G-FORGTM123" }), { ok: true, id: "G-FORGTM123" });
  assert.deepEqual(resolveGa4MeasurementId(null, { GA4_MEASUREMENT_ID: "nonsense" }), { ok: false, reason: "invalid_measurement_id" });
  assert.deepEqual(resolveGa4Config("G-STORE123", {}), { ok: false, reason: "no_secret" });
  const ok = resolveGa4Config("G-STORE123", { GA4_API_SECRET: ` ${SECRET}\n`, GA4_MP_DEBUG: "TRUE" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.config, { measurementId: "G-STORE123", apiSecret: SECRET, debug: true });
});

const order: PurchaseInput = {
  orderNumber: "GP-501", total: 3290.5, shipping: 70, tax: 20, coupon: "WELCOME10", currency: "BDT",
  items: [{ id: "p1", name: "Clay Mug", price: 650, quantity: 2, variant: "Red" }, { id: "p2", name: "Vase", price: 1800.5, quantity: 1 }],
};

test("GA4 server purchase payload: client_id, back-dated timestamp, transaction_id, BDT, value (items net of discount), tax, shipping, coupon, items, session", () => {
  const eventTime = new Date(NOW - 5 * 60_000);
  const p = buildGa4PurchasePayload({ order, eventId: "purchase_GP-501", clientId: "1234567890.1700000000", sessionId: "1700000000", eventTime });
  assert.equal(p.client_id, "1234567890.1700000000");
  assert.equal(p.timestamp_micros, eventTime.getTime() * 1000);
  assert.equal(p.events.length, 1);
  const e = p.events[0];
  assert.equal(e.name, "purchase");
  assert.equal(e.params.transaction_id, "GP-501");
  assert.equal(e.params.currency, "BDT");
  assert.equal(e.params.value, 3200.5);
  assert.equal(e.params.tax, 20);
  assert.equal(e.params.shipping, 70);
  assert.equal(e.params.coupon, "WELCOME10");
  assert.equal(e.params.session_id, "1700000000");
  assert.equal(e.params.engagement_time_msec, 1);
  assert.deepEqual((e.params.items as object[])[0], { item_id: "p1", item_name: "Clay Mug", price: 650, quantity: 2, item_variant: "Red" });
  assert.equal((e.params.items as object[]).length, 2);
  // Built by the SAME function as the browser's, so the two shapes cannot drift.
  const browser = purchaseEvent(order, "purchase_GP-501").ga4!.params;
  for (const k of Object.keys(browser)) assert.deepEqual(e.params[k], browser[k], k);
  // No customer data, no coupon/session when absent.
  assert.ok(!/@|\d{11,}/.test(JSON.stringify({ ...p, timestamp_micros: 0 }).replace(/1700000000|1234567890/g, "")), "no email / phone-like number");
  const bare = buildGa4PurchasePayload({ order: { ...order, coupon: null }, eventId: "x", clientId: "1.1", eventTime });
  assert.ok(!("coupon" in bare.events[0].params) && !("session_id" in bare.events[0].params));
});

function mockFetch(status: number, body?: unknown) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const payload = () => buildGa4PurchasePayload({ order, eventId: "e", clientId: "1.1", eventTime: new Date(NOW) });

test("send: the secret travels only in the URL query (Google's design), never in the body; success is any 2xx", async () => {
  const f = mockFetch(204);
  const r = await sendGa4Purchase(cfg, payload(), { fetchImpl: f.impl });
  assert.deepEqual(r, { ok: true, httpStatus: 204 });
  assert.equal(f.calls[0].url, `https://www.google-analytics.com/mp/collect?measurement_id=G-ABCD1234&api_secret=${encodeURIComponent(SECRET)}`);
  assert.ok(!JSON.stringify(f.calls[0].body).includes(SECRET));
});

test("send failures: 5xx / 429 / network / timeout are retryable; other 4xx are permanent; the secret never appears in a returned message", async () => {
  for (const [status, retryable] of [[500, true], [503, true], [429, true], [400, false], [403, false], [404, false]] as const) {
    const r = await sendGa4Purchase(cfg, payload(), { fetchImpl: mockFetch(status).impl });
    assert.ok(!r.ok && r.retryable === retryable, String(status));
    assert.ok(!JSON.stringify(r).includes(SECRET));
  }
  const net = await sendGa4Purchase(cfg, payload(), { fetchImpl: (async () => { throw new TypeError(`fetch failed for https://x/?api_secret=${SECRET}`); }) as never });
  assert.ok(!net.ok && net.retryable && net.code === "network");
  assert.ok(!JSON.stringify(net).includes(SECRET), "a thrown error's text (which can contain the URL) is never echoed");
  const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  const t = await sendGa4Purchase(cfg, payload(), { fetchImpl: hang, timeoutMs: 30 });
  assert.ok(!t.ok && t.retryable && t.code === "timeout");
});

test("validation (debug) mode: goes to the debug endpoint, reports Google's messages as a permanent failure, and a valid event is marked debugOnly (NOT recorded)", async () => {
  const bad = mockFetch(200, { validationMessages: [{ fieldPath: "events[0].params.value", description: `value must be numeric ${SECRET}`, validationCode: "VALUE_INVALID" }] });
  const r = await sendGa4Purchase({ ...cfg, debug: true }, payload(), { fetchImpl: bad.impl });
  assert.ok(bad.calls[0].url.startsWith("https://www.google-analytics.com/debug/mp/collect?"));
  assert.ok(!r.ok && !r.retryable && r.code === "validation");
  assert.match(!r.ok ? r.message : "", /events\[0\]\.params\.value/);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const good = await sendGa4Purchase({ ...cfg, debug: true }, payload(), { fetchImpl: mockFetch(200, { validationMessages: [] }).impl });
  assert.deepEqual(good, { ok: true, httpStatus: 200, debugOnly: true });
});

test("browser/server duplicate prevention: the browser Purchase drops its GA4 part when the server owns GA4 (Meta part and shared event id are untouched)", () => {
  const withGa4 = purchaseEvent(order, "purchase_GP-501");
  const serverOwnsGa4 = purchaseEvent(order, "purchase_GP-501", { includeGa4: false });
  assert.ok(withGa4.ga4);
  assert.equal(serverOwnsGa4.ga4, undefined);
  assert.equal(serverOwnsGa4.meta?.name, "Purchase");
  assert.equal(serverOwnsGa4.eventId, withGa4.eventId);
  assert.equal(serverOwnsGa4.eventId, "purchase_GP-501");
  assert.equal(purchaseEvent(order, "e", { includeGa4: true }).ga4 !== undefined, true);
});

test("event age windows: Meta 7 days; GA4 71 hours (older GA4 events would be silently re-dated, so they are skipped)", () => {
  assert.equal(maxEventAgeMs("META_CAPI"), META_MAX_EVENT_AGE_MS);
  assert.equal(maxEventAgeMs("GA4_MP"), GA4_MAX_EVENT_AGE_MS);
  assert.equal(GA4_MAX_EVENT_AGE_MS, 71 * 3_600_000);
  assert.equal(isEventTooOld(new Date(NOW - 70 * 3_600_000), NOW, GA4_MAX_EVENT_AGE_MS), false);
  assert.equal(isEventTooOld(new Date(NOW - 73 * 3_600_000), NOW, GA4_MAX_EVENT_AGE_MS), true);
  assert.equal(isEventTooOld(new Date(NOW - 73 * 3_600_000), NOW), false, "same age is still fine for Meta");
});

test("diagnostics: GA4 server state without ever containing the secret; warnings explain the browser-only fallback and debug mode", () => {
  const settings = { metaPixelId: null, gtmId: "G-ABCD1234", tiktokPixelId: null, consentMode: "OPT_IN" as const };
  const ready = describeTrackingConfig(settings, { GA4_API_SECRET: SECRET, CRON_SECRET: "c".repeat(32) });
  assert.deepEqual(ready.ga4Server, { state: "ready", measurementId: "G-ABCD1234", validationOnly: false });
  assert.ok(!JSON.stringify(ready).includes(SECRET));
  assert.deepEqual(ready.missingEnv, []);

  const noSecret = describeTrackingConfig(settings, {});
  assert.equal(noSecret.ga4Server.state, "no_secret");
  assert.ok(noSecret.warnings.some((w) => /only from the browser/.test(w)));

  const noJob = describeTrackingConfig(settings, { GA4_API_SECRET: SECRET });
  assert.deepEqual(noJob.missingEnv, ["CRON_SECRET"]);

  const debug = describeTrackingConfig(settings, { GA4_API_SECRET: SECRET, GA4_MP_DEBUG: "true", CRON_SECRET: "c".repeat(32) });
  assert.equal(debug.ga4Server.validationOnly, true);
  assert.ok(debug.warnings.some((w) => /NOT recorded/.test(w)));

  const gtm = describeTrackingConfig({ ...settings, gtmId: "GTM-ABCD12" }, { GA4_API_SECRET: SECRET });
  assert.equal(gtm.ga4Server.state, "no_measurement_id");
  assert.ok(gtm.warnings.some((w) => /GA4_MEASUREMENT_ID/.test(w)));
});

test("STATIC schema/migration check (Prisma validate is unavailable offline): every column the tracking migrations add exists in schema.prisma", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const model = (name: string) => new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
  const dirs = readdirSync("prisma/migrations").filter((d) => /^2026112[23]/.test(d)).sort();
  assert.deepEqual(dirs, ["20261122000000_tracking_p3", "20261123000000_tracking_p31"]);
  let checked = 0;
  for (const d of dirs) {
    const sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8");
    // CREATE TABLE "X" ( "col" TYPE, ... )
    for (const m of sql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
      for (const c of m[2].matchAll(/^\s+"(\w+)"/gm)) { assert.match(model(m[1]), new RegExp(`\\n\\s+${c[1]}\\s`), `${m[1]}.${c[1]}`); checked++; }
    }
    // ALTER TABLE "X" ADD COLUMN "col" ...
    for (const m of sql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN([\s\S]*?);/g)) {
      for (const c of m[2].matchAll(/(?:^|\n|,)\s*(?:ADD COLUMN\s+)?"(\w+)"\s+(?:TEXT|TIMESTAMP|INTEGER|JSONB)/g)) { assert.match(model(m[1]), new RegExp(`\\n\\s+${c[1]}\\s`), `${m[1]}.${c[1]}`); checked++; }
    }
  }
  assert.equal(checked, 36, "20 TrackingEventLog + 12 OrderAttribution (P3) + 4 added by P3.1: the parser must have seen every column");
  // The P3.1 migration is strictly additive.
  const p31 = readFileSync(`prisma/migrations/${dirs[1]}/migration.sql`, "utf8").replace(/--.*$/gm, "");
  assert.ok(!/\bDROP\b|\bDELETE\b|\bUPDATE\b|\bRENAME\b|\bSET NOT NULL\b|ALTER COLUMN/i.test(p31), "additive only");
});
