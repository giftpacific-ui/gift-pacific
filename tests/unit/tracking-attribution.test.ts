import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderAttributionRecord, cleanText, fbcFromFbclid, isValidFbc, isValidFbp, mergeAttribution, parseAttributionCookie,
  referrerHostOf, resolveFbc, serializeAttributionCookie, touchFromLocation, type AttributionCookie,
} from "@/lib/analytics/attribution";

const NOW = 1_800_000_000_000;
const META_URL =
  "?utm_source=fb&utm_medium=paid_social&utm_campaign=Eid%20Sale&utm_content=Video%201&utm_term=Dhaka%2025-34&campaign_id=120211111111&adset_id=120222222222&ad_id=120233333333&placement=Facebook_Mobile_Feed&fbclid=IwAR0abcdefghijklmnop";
const land = (search: string, over: Record<string, unknown> = {}, now = NOW) =>
  touchFromLocation({ pathname: "/products/rose-box", search, referrer: "https://l.facebook.com/", ownHost: "shop.test", now, ...over });

test("captures every Meta Ads parameter on the first landing, plus landing path (no query) and referrer HOST only", () => {
  const t = land(META_URL)!;
  assert.deepEqual(t, {
    at: NOW, source: "fb", medium: "paid_social", campaign: "Eid Sale", content: "Video 1", term: "Dhaka 25-34",
    campaignId: "120211111111", adsetId: "120222222222", adId: "120233333333", placement: "Facebook_Mobile_Feed",
    fbclid: "IwAR0abcdefghijklmnop", landing: "/products/rose-box", referrerHost: "l.facebook.com",
  });
  assert.ok(!JSON.stringify(t).includes("?"), "no query string is stored");
});

test("first touch is written once and NEVER overwritten; last touch follows later eligible landings", () => {
  const first = land(META_URL)!;
  let { cookie } = mergeAttribution(null, first);
  assert.deepEqual(cookie?.first, first);
  assert.deepEqual(cookie?.last, first);

  const later = land("?utm_source=google&utm_medium=cpc&utm_campaign=Brand", { referrer: "https://www.google.com/" }, NOW + 86_400_000)!;
  const m = mergeAttribution(cookie, later);
  assert.equal(m.changed, true);
  assert.deepEqual(m.cookie?.first, first, "first touch intact");
  assert.equal(m.cookie?.last?.source, "google");
  cookie = m.cookie;

  // A direct revisit changes nothing: it must not erase the last real source.
  const direct = land("", { referrer: "" }, NOW + 2 * 86_400_000)!;
  const d = mergeAttribution(cookie, direct);
  assert.equal(d.changed, false);
  assert.equal(d.cookie?.last?.source, "google");
});

test("a direct first visit is recorded as the (direct) first touch, so a later paid click cannot pose as the original", () => {
  const direct = land("", { referrer: "" })!;
  const { cookie } = mergeAttribution(null, direct);
  assert.equal(cookie?.first?.source, undefined);
  assert.equal(cookie?.last, undefined);
  const paid = mergeAttribution(cookie, land(META_URL, {}, NOW + 1000)!);
  assert.equal(paid.cookie?.first?.at, NOW, "first touch still the direct visit");
  assert.equal(paid.cookie?.last?.source, "fb");
});

test("internal referrers and private routes are not captured", () => {
  assert.equal(referrerHostOf("https://shop.test/shop", "shop.test"), undefined);
  assert.equal(referrerHostOf("https://www.shop.test/x", "shop.test"), undefined);
  assert.equal(land(META_URL, { pathname: "/admin/orders" }), null);
  // Confirmation pages are trackable, but the order number must never end up in attribution data.
  assert.equal(land(META_URL, { pathname: "/checkout/confirmation/GP-1" })?.landing, "/checkout/confirmation");
});

test("hostile or malformed values are dropped, unresolved ad macros are rejected, lengths are capped", () => {
  assert.equal(cleanText("{{campaign.name}}"), undefined);
  assert.equal(cleanText("<script>alert(1)</script>"), "scriptalert(1)/script");
  assert.equal(cleanText("x".repeat(500), 120)?.length, 120);
  const t = land("?utm_source=" + encodeURIComponent("{{site_source_name}}") + "&campaign_id=abc&ad_id=12&fbclid=short&placement=" + "p".repeat(200))!;
  assert.equal(t.source, undefined);
  assert.equal(t.campaignId, undefined); // ids must be numeric
  assert.equal(t.adId, undefined);       // and plausibly long
  assert.equal(t.fbclid, undefined);
  assert.equal(t.placement?.length, 60);
});

test("the server re-validates the (client-controlled) cookie: forged fields, bad timestamps and junk are rejected", () => {
  const good = serializeAttributionCookie({ v: 1, first: land(META_URL)!, last: land(META_URL)! });
  assert.ok(parseAttributionCookie(good, NOW)?.first?.campaignId === "120211111111");

  const forged = encodeURIComponent(JSON.stringify({
    v: 1,
    first: { at: NOW, source: "<img src=x onerror=1>", campaignId: "1; DROP TABLE", fbclid: "x", landing: "//evil.com/x", referrerHost: "not a host", extra: "ignored" },
    last: { at: NOW + 10 * 86_400_000, source: "future" }, // timestamp in the future => whole touch dropped
  }));
  const parsed = parseAttributionCookie(forged, NOW)!;
  assert.equal(parsed.last, undefined);
  assert.equal(parsed.first?.source, "img src=x onerror=1".replace(/[<>"'`\\;{}]/g, "")); // markup chars stripped
  assert.equal(parsed.first?.campaignId, undefined);
  assert.equal(parsed.first?.landing, undefined);
  assert.equal(parsed.first?.referrerHost, undefined);
  assert.ok(!("extra" in (parsed.first as object)));

  for (const junk of [undefined, "", "%7Bnot-json", encodeURIComponent("[]"), encodeURIComponent(JSON.stringify({ v: 2, first: { at: NOW } })), "x".repeat(7000)]) {
    assert.equal(parseAttributionCookie(junk, NOW), null);
  }
});

test("fbc / fbp: only real shapes are accepted; fbc is derived from fbclid when the _fbc cookie is absent; case is preserved", () => {
  assert.equal(isValidFbc("fb.1.1700000000000.AbCdEfGh12", NOW), true);
  assert.equal(isValidFbc("fb.1.1700000000000.short", NOW), false);
  assert.equal(isValidFbc("fb.1.9999999999999.AbCdEfGh12", NOW), false); // far future
  assert.equal(isValidFbp("fb.1.1700000000000.1234567890", NOW), true);
  assert.equal(isValidFbp("garbage", NOW), false);
  assert.equal(fbcFromFbclid("AbCdEf", 5), "fb.1.5.AbCdEf");
  const c: AttributionCookie = { v: 1, first: land(META_URL)! };
  assert.equal(resolveFbc(undefined, c, NOW), `fb.1.${NOW}.IwAR0abcdefghijklmnop`);
  assert.equal(resolveFbc("fb.1.1700000000000.CookieValue1", c, NOW), "fb.1.1700000000000.CookieValue1"); // cookie wins
  assert.equal(resolveFbc("bad", undefined, NOW), undefined);
});

test("order snapshot: consent OFF stores everything validated; OPT_IN without a grant stores ONLY the consent state", () => {
  const cookie = serializeAttributionCookie({ v: 1, first: land(META_URL)!, last: land(META_URL)! });
  const base = { attributionCookie: cookie, fbpCookie: "fb.1.1700000000000.1234567890", ip: "203.0.113.7", userAgent: "Mozilla/5.0", now: NOW };

  const off = buildOrderAttributionRecord({ ...base, consentState: "NOT_REQUIRED" });
  assert.equal(off.consentState, "NOT_REQUIRED");
  assert.equal(off.firstTouch?.campaign, "Eid Sale");
  assert.equal(off.fbp, "fb.1.1700000000000.1234567890");
  assert.equal(off.fbc, `fb.1.${NOW}.IwAR0abcdefghijklmnop`);
  assert.equal(off.clientIp, "203.0.113.7");
  assert.equal(off.clientUserAgent, "Mozilla/5.0");

  for (const state of ["UNKNOWN", "DENIED"] as const) {
    assert.deepEqual(buildOrderAttributionRecord({ ...base, consentState: state }), {
      firstTouch: null, lastTouch: null, fbc: null, fbp: null, clientIp: null, clientUserAgent: null, gaClientId: null, gaSessionId: null, consentRef: null, consentState: state,
    });
  }
  const granted = buildOrderAttributionRecord({ ...base, consentState: "GRANTED" });
  assert.equal(granted.clientIp, "203.0.113.7");
});

test("an invalid IP is dropped, not stored", () => {
  const r = buildOrderAttributionRecord({ consentState: "NOT_REQUIRED", ip: "not-an-ip", userAgent: "UA", now: NOW });
  assert.equal(r.clientIp, null);
  assert.equal(r.clientUserAgent, "UA");
});
