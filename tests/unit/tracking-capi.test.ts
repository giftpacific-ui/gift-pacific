import { test } from "node:test";
import assert from "node:assert/strict";
import {
  META_API_VERSION_DEFAULT, buildPurchaseEvent, buildUserData, classifyMetaFailure, normalizeCity, normalizeCountry, normalizeEmail,
  normalizeName, normalizePhone, redactSensitive, resolveApiVersion, resolveMetaConfig, sendMetaEvents, sha256,
} from "@/lib/analytics/server-events";
import {
  MAX_DELIVERY_ATTEMPTS, PURCHASE_ELIGIBLE_STATUSES, consentSnapshotFor, isEventTooOld, isTrackingPermitted, mayDeliverServerEvent,
  nextRetryDelayMs, purchaseEligibility,
} from "@/lib/analytics/purchase-policy";
import { describeTrackingConfig } from "@/server/services/tracking-diagnostics.service";

const NOW = 1_800_000_000_000;
const TOKEN = "EAAGsecrettokenvalue1234567890";
const cfg = { pixelId: "123456789", accessToken: TOKEN, apiVersion: "v25.0" };
const order = {
  orderNumber: "GP-77", total: 1870, currency: "BDT", email: "Jane.Doe@Example.com ", phone: "01711000000", userId: "user-1",
  shipping: { fullName: "Jane Marie Doe", city: "Dhaka", country: "Bangladesh" },
  items: [{ productId: "p1", quantity: 2, unitPrice: 800 }, { productId: "p1", quantity: 1, unitPrice: 800 }, { productId: "p2", quantity: 1, unitPrice: 270.456 }],
};
const buildEvt = (over: Record<string, unknown> = {}) =>
  buildPurchaseEvent({
    order, eventId: "purchase_GP-77", eventTime: new Date(NOW), sourceUrl: "https://shop.test/checkout", now: NOW,
    attribution: { fbc: "fb.1.1700000000000.AbCdEfGh12", fbp: "fb.1.1700000000000.1234567890", ip: "203.0.113.7", userAgent: "Mozilla/5.0" }, ...over,
  });

test("hashing: known SHA-256 vector, and every identifier is normalised BEFORE hashing", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(normalizeEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  assert.equal(normalizeEmail("no-at-sign"), undefined);
  assert.equal(normalizePhone("01711000000"), "8801711000000");
  assert.equal(normalizePhone("+880 1711-000000"), "8801711000000");
  assert.equal(normalizePhone("008801711000000"), "8801711000000");
  assert.equal(normalizePhone("1711000000"), "8801711000000");
  assert.equal(normalizePhone("123"), undefined);
  assert.equal(normalizeName("  Éloïse-Marie. "), "éloïsemarie");
  assert.equal(normalizeCity("New  York!"), "newyork");
  assert.equal(normalizeCountry("Bangladesh"), "bd");
  assert.equal(normalizeCountry("BD"), "bd");
  assert.equal(normalizeCountry("Narnia"), undefined);
});

test("user_data: PII is hashed, ip / user agent / fbc / fbp are sent RAW, invalid fbc is dropped, nothing plaintext leaks", () => {
  const u = buildUserData(
    { email: order.email, phone: order.phone, fullName: order.shipping.fullName, city: "Dhaka", country: "Bangladesh", userId: "user-1",
      ip: "203.0.113.7", userAgent: "Mozilla/5.0", fbc: "fb.1.1700000000000.AbCdEfGh12", fbp: "fb.1.1700000000000.1234567890" }, NOW);
  assert.deepEqual(u.em, [sha256("jane.doe@example.com")]);
  assert.deepEqual(u.ph, [sha256("8801711000000")]);
  assert.deepEqual(u.fn, [sha256("jane")]);
  assert.deepEqual(u.ln, [sha256("doe")]);
  assert.deepEqual(u.ct, [sha256("dhaka")]);
  assert.deepEqual(u.country, [sha256("bd")]);
  assert.deepEqual(u.external_id, [sha256("user-1")]);
  assert.equal(u.client_ip_address, "203.0.113.7");
  assert.equal(u.client_user_agent, "Mozilla/5.0");
  assert.equal(u.fbc, "fb.1.1700000000000.AbCdEfGh12");
  const json = JSON.stringify(u);
  for (const plain of ["jane", "Jane", "example.com", "1711000000", "Dhaka", "Bangladesh"]) assert.ok(!json.includes(plain), `plaintext ${plain}`);
  assert.equal(buildUserData({ fbc: "garbage", fbp: "garbage" }, NOW).fbc, undefined);
  assert.deepEqual(buildUserData({}, NOW), {}); // nothing invented
});

test("Purchase payload: server data only; BDT value = order total; unique content_ids; contents with id, quantity, item_price; order_id; event_time in seconds", () => {
  const e = buildEvt();
  assert.equal(e.event_name, "Purchase");
  assert.equal(e.event_id, "purchase_GP-77");
  assert.equal(e.event_time, NOW / 1000);
  assert.equal(e.action_source, "website");
  assert.equal(e.event_source_url, "https://shop.test/checkout");
  assert.ok(!e.event_source_url?.includes("GP-77"), "no order number in the source url");
  assert.deepEqual(e.custom_data, {
    currency: "BDT", value: 1870, content_type: "product", content_ids: ["p1", "p2"],
    contents: [{ id: "p1", quantity: 2, item_price: 800 }, { id: "p1", quantity: 1, item_price: 800 }, { id: "p2", quantity: 1, item_price: 270.46 }],
    num_items: 4, order_id: "GP-77",
  });
});

test("without a captured browser user agent the event is NOT claimed as a website event and carries no source url", () => {
  const e = buildEvt({ attribution: { ip: "203.0.113.7" } });
  assert.equal(e.action_source, "other");
  assert.equal("event_source_url" in e, false);
});

test("Graph API version: current default, env override accepted only in vNN.N form (v20.0 is retired)", () => {
  assert.equal(META_API_VERSION_DEFAULT, "v25.0");
  assert.notEqual(META_API_VERSION_DEFAULT, "v20.0");
  assert.equal(resolveApiVersion({}), "v25.0");
  assert.equal(resolveApiVersion({ META_GRAPH_API_VERSION: "v26.0" }), "v26.0");
  for (const bad of ["26", "latest", "v2.0", "../v1", "v25.0/x"]) assert.equal(resolveApiVersion({ META_GRAPH_API_VERSION: bad }), "v25.0");
});

test("config: admin pixel beats env, test code is validated, a missing token or bad pixel yields a reason (never a half-config)", () => {
  const ok = resolveMetaConfig("111111", { META_CONVERSIONS_API_TOKEN: ` ${TOKEN}\n`, NEXT_PUBLIC_META_PIXEL_ID: "999999", META_CAPI_TEST_EVENT_CODE: "TEST12345" });
  assert.ok(ok.ok);
  assert.equal(ok.config.pixelId, "111111");
  assert.equal(ok.config.accessToken, TOKEN, "whitespace trimmed");
  assert.equal(ok.config.testEventCode, "TEST12345");
  const noTest = resolveMetaConfig("111111", { META_CONVERSIONS_API_TOKEN: "t", META_CAPI_TEST_EVENT_CODE: "bad code!" });
  assert.ok(noTest.ok && !("testEventCode" in noTest.config));
  assert.deepEqual(resolveMetaConfig("", {}), { ok: false, reason: "no_pixel" });
  assert.deepEqual(resolveMetaConfig("12ab", { META_CONVERSIONS_API_TOKEN: "t" }), { ok: false, reason: "invalid_pixel" });
});

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("send: token only in the body (never the URL), version + pixel in the path, test_event_code only when configured", async () => {
  const f = mockFetch(200, { events_received: 1, fbtrace_id: "TRACE1" });
  const r = await sendMetaEvents({ ...cfg, testEventCode: "TEST1" }, [buildEvt()], { fetchImpl: f.impl });
  assert.deepEqual(r, { ok: true, httpStatus: 200, fbtraceId: "TRACE1" });
  assert.equal(f.calls[0].url, "https://graph.facebook.com/v25.0/123456789/events");
  assert.ok(!f.calls[0].url.includes(TOKEN));
  assert.equal(f.calls[0].body.access_token, TOKEN);
  assert.equal(f.calls[0].body.test_event_code, "TEST1");
  const g = mockFetch(200, { events_received: 1 });
  await sendMetaEvents(cfg, [buildEvt()], { fetchImpl: g.impl });
  assert.ok(!("test_event_code" in g.calls[0].body));
});

test("failure classification: transient (5xx, 429, is_transient, rate-limit codes, network, timeout) retry; permanent (bad token, bad params, zero events) do not", async () => {
  for (const [status, body, retryable] of [
    [500, {}, true], [503, null, true], [429, {}, true],
    [400, { error: { code: 4, message: "rate" } }, true],
    [400, { error: { code: 2, is_transient: true, message: "x" } }, true],
    [400, { error: { code: 100, message: "bad param" } }, false],
    [400, { error: { code: 190, message: "token expired" } }, false],
    [403, { error: { code: 200, message: "perm" } }, false],
  ] as const) {
    assert.equal(classifyMetaFailure(status, body as never).retryable, retryable, `${status} ${JSON.stringify(body)}`);
  }
  const zero = await sendMetaEvents(cfg, [buildEvt()], { fetchImpl: mockFetch(200, { events_received: 0 }).impl });
  assert.equal(zero.ok, false);
  assert.equal(!zero.ok && zero.retryable, false);

  const net = await sendMetaEvents(cfg, [buildEvt()], { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as never });
  assert.ok(!net.ok && net.retryable && net.code === "network");
});

test("timeout: a hung Meta request is aborted and reported as retryable (it cannot hold checkout/admin requests open)", async () => {
  const hang = ((_u: string, init: RequestInit) =>
    new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  const started = Date.now();
  const r = await sendMetaEvents(cfg, [buildEvt()], { fetchImpl: hang, timeoutMs: 30 });
  assert.ok(!r.ok && r.retryable && r.code === "timeout");
  assert.ok(Date.now() - started < 1000);
});

test("error text never carries the token, an email or a phone number", async () => {
  const leaky = mockFetch(400, { error: { code: 100, message: `Invalid token ${TOKEN} for jane@example.com / 8801711000000` } });
  const r = await sendMetaEvents(cfg, [buildEvt()], { fetchImpl: leaky.impl });
  assert.ok(!r.ok);
  const msg = JSON.stringify(r);
  assert.ok(!msg.includes(TOKEN) && !msg.includes("jane@") && !msg.includes("8801711000000"), msg);
  assert.ok(redactSensitive("x".repeat(1000)).length <= 300);
});

test("retry schedule: exponential back-off, gives up after MAX_DELIVERY_ATTEMPTS; events older than Meta's window are 'too old'", () => {
  const delays = [1, 2, 3, 4, 5].map(nextRetryDelayMs);
  assert.deepEqual(delays, [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
  assert.equal(nextRetryDelayMs(MAX_DELIVERY_ATTEMPTS), null);
  assert.equal(isEventTooOld(new Date(NOW - 6 * 86_400_000), NOW), false);
  assert.equal(isEventTooOld(new Date(NOW - 8 * 86_400_000), NOW), true);
});

test("Purchase eligibility: ONLY confirmed-or-later website orders; pending, cancelled, refunded and marketplace orders are never eligible", () => {
  for (const s of PURCHASE_ELIGIBLE_STATUSES) assert.equal(purchaseEligibility({ status: s, channelId: "channel_website" }).eligible, true, s);
  for (const s of ["PENDING", "CANCELLED", "REFUND_REQUESTED", "REFUNDED", "FAILED_DELIVERY", "NOPE"]) {
    assert.deepEqual(purchaseEligibility({ status: s, channelId: "channel_website" }), { eligible: false, reason: "order_not_eligible" }, s);
  }
  assert.deepEqual(purchaseEligibility({ status: "CONFIRMED", channelId: "channel_amazon" }), { eligible: false, reason: "not_website_order" });
});

test("consent policy: OFF = not required (documented default); OPT_IN needs an explicit grant; the CURRENT mode judges the stored snapshot", () => {
  assert.equal(consentSnapshotFor("OFF", undefined), "NOT_REQUIRED");
  assert.equal(consentSnapshotFor("OFF", "denied"), "NOT_REQUIRED");
  assert.equal(consentSnapshotFor("OPT_IN", "granted"), "GRANTED");
  assert.equal(consentSnapshotFor("OPT_IN", "denied"), "DENIED");
  assert.equal(consentSnapshotFor("OPT_IN", undefined), "UNKNOWN");
  assert.equal(consentSnapshotFor("OPT_IN", "yes please"), "UNKNOWN");
  assert.equal(isTrackingPermitted("UNKNOWN"), false);
  assert.equal(isTrackingPermitted("DENIED"), false);
  assert.equal(isTrackingPermitted("GRANTED"), true);
  // OPT_IN store: only GRANTED is sent.
  for (const [snap, want] of [["GRANTED", true], ["DENIED", false], ["UNKNOWN", false], ["NOT_REQUIRED", false]] as const) assert.equal(mayDeliverServerEvent("OPT_IN", snap), want, `OPT_IN ${snap}`);
  // OFF store: only an explicit denial blocks.
  for (const [snap, want] of [["GRANTED", true], ["DENIED", false], ["UNKNOWN", true], ["NOT_REQUIRED", true]] as const) assert.equal(mayDeliverServerEvent("OFF", snap), want, `OFF ${snap}`);
});

test("diagnostics: reports what is configured/missing without ever containing the token", () => {
  const env = { META_CONVERSIONS_API_TOKEN: TOKEN, CRON_SECRET: "c".repeat(32), NEXT_PUBLIC_GTM_ID: "G-ABCD1234" };
  const d = describeTrackingConfig({ metaPixelId: "123456789", gtmId: null, tiktokPixelId: null, consentMode: "OFF" }, env);
  assert.deepEqual(d.meta, { pixelConfigured: true, pixelSource: "admin settings", pixelId: "123456789", capiState: "ready", apiVersion: "v25.0", testEventCodeActive: false });
  assert.deepEqual(d.google, { configured: true, kind: "GA4", source: "environment" });
  assert.equal(d.retryJobEnabled, true);
  assert.deepEqual(d.missingEnv, []);
  assert.ok(!JSON.stringify(d).includes(TOKEN) && !JSON.stringify(d).includes("c".repeat(32)));
  assert.ok(d.warnings.some((w) => /Consent mode is OFF/.test(w)));

  const bare = describeTrackingConfig({ metaPixelId: "123456789", gtmId: "GTM-ABCD12", tiktokPixelId: null, consentMode: "OPT_IN" }, {});
  assert.equal(bare.meta.capiState, "no_token");
  assert.deepEqual(bare.missingEnv, ["META_CONVERSIONS_API_TOKEN"]);
  assert.equal(bare.google.kind, "GTM");
  assert.equal(bare.retryJobEnabled, false);
  const bad = describeTrackingConfig({ metaPixelId: "abc", gtmId: "nonsense", tiktokPixelId: null, consentMode: "OFF" }, { META_CAPI_TEST_EVENT_CODE: "TEST1" });
  assert.equal(bad.meta.pixelConfigured, false);
  assert.equal(bad.google.configured, false);
  assert.ok(bad.warnings.length >= 3);
});
