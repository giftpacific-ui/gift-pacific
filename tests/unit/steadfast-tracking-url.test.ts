import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrackingUrl, getCourierConfig, getCourierProviderConfig, parseTrackingUrlTemplate } from "@/lib/courier/config";

const creds = { STEADFAST_API_KEY: "k", STEADFAST_API_SECRET: "s" };
const cfgWith = (tpl: string | undefined) => getCourierProviderConfig("steadfast", { ...creds, ...(tpl === undefined ? {} : { STEADFAST_TRACKING_URL_TEMPLATE: tpl }) });

test("STEADFAST_TRACKING_URL_TEMPLATE is read from the environment and {id} is replaced by the tracking ID", () => {
  const cfg = cfgWith("https://track.example/t/{id}");
  assert.equal(cfg.trackingUrlTemplate, "https://track.example/t/{id}");
  assert.equal(buildTrackingUrl(cfg, "ABC123"), "https://track.example/t/ABC123");
  assert.equal(buildTrackingUrl(cfgWith("https://track.example/?code={id}&x=1"), "ABC123"), "https://track.example/?code=ABC123&x=1");
  assert.equal(buildTrackingUrl(cfgWith("https://track.example/{id}/status/{id}"), "A1"), "https://track.example/A1/status/A1");
});

test("the legacy COURIER_TRACKING_URL_TEMPLATE still works for the legacy provider, and the Steadfast name wins", () => {
  const legacy = { COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "k", COURIER_API_SECRET: "s", COURIER_TRACKING_URL_TEMPLATE: "https://old.example/{id}" };
  assert.equal(buildTrackingUrl(getCourierConfig(legacy), "A"), "https://old.example/A");
  assert.equal(buildTrackingUrl(getCourierConfig({ ...legacy, STEADFAST_TRACKING_URL_TEMPLATE: "https://new.example/{id}" }), "A"), "https://new.example/A");
});

test("empty, missing or invalid template → no URL (never a broken or fake one)", () => {
  for (const tpl of [undefined, "", "   ", "https://track.example/t/", "http://track.example/{id}", "javascript:{id}", "//track.example/{id}", "track.example/{id}",
    "https://{id}.example/", "https://track.example{id}", "https://user:pw@track.example/{id}", "https://track.example/{other}/{id}", "https://track.example/a b/{id}", "https://{id}"]) {
    const cfg = cfgWith(tpl);
    assert.equal(cfg.trackingUrlTemplate, null, String(tpl));
    assert.equal(buildTrackingUrl(cfg, "ABC"), null, String(tpl));
  }
  assert.equal(parseTrackingUrlTemplate(null), null);
});

test("missing / blank tracking ID → no URL", () => {
  const cfg = cfgWith("https://track.example/t/{id}");
  for (const id of [null, undefined, "", "   "]) assert.equal(buildTrackingUrl(cfg, id), null);
  assert.equal(buildTrackingUrl(cfgWith(undefined), "ABC"), null);
});

test("the tracking ID is URL-encoded: it cannot add path segments, query parameters, fragments or change the host", () => {
  const cfg = cfgWith("https://track.example/t/{id}");
  assert.equal(buildTrackingUrl(cfg, " A B/1 "), "https://track.example/t/A%20B%2F1");
  assert.equal(buildTrackingUrl(cfg, "x?y=1#z"), "https://track.example/t/x%3Fy%3D1%23z");
  assert.equal(buildTrackingUrl(cfg, "../../admin"), "https://track.example/t/..%2F..%2Fadmin");
  assert.equal(buildTrackingUrl(cfg, "@evil.example"), "https://track.example/t/%40evil.example");
  assert.equal(buildTrackingUrl(cfg, "ডাক১২৩"), `https://track.example/t/${encodeURIComponent("ডাক১২৩")}`);
  const u = new URL(buildTrackingUrl(cfg, "a/../b?c#d")!);
  assert.equal(u.host, "track.example");
  assert.equal(u.search, "");
  assert.equal(u.hash, "");
});

test("an over-long result is refused rather than truncated", () => {
  const cfg = cfgWith("https://track.example/t/{id}");
  assert.equal(buildTrackingUrl(cfg, "a".repeat(201)), null);
  assert.equal(buildTrackingUrl(cfgWith("https://track.example/{id}/{id}/{id}"), "a".repeat(190)), null);
});
