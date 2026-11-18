import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isValidLinkedInId, isValidTikTokId } from "@/lib/analytics/ids";
import { storeSettingsFormSchema } from "@/lib/validations/admin";
import { buildPurchaseEvent, resolveMetaConfig, sendMetaEvents } from "@/lib/analytics/server-events";

test("TikTok and LinkedIn ids: real-looking ids pass; anything that could break out of an inline script fails", () => {
  for (const ok of ["C1A2B3C4D5E6F7G8H9I0", "CABCDEFGHIJ1234567"]) assert.equal(isValidTikTokId(ok), true, ok);
  for (const bad of ["", "short", "c1a2b3c4d5e6f7g8h9i0", "ABC'); alert(1);//", "ABC DEF GHI JKL", "A".repeat(31), "AB-CD-EF-GH-IJ", null, undefined]) assert.equal(isValidTikTokId(bad as never), false, String(bad));
  for (const ok of ["1234", "1234567", "123456789012"]) assert.equal(isValidLinkedInId(ok), true, ok);
  for (const bad of ["", "123", "1234567890123", "12a45", "1234\"; alert(1)", "1234 5678", null, undefined]) assert.equal(isValidLinkedInId(bad as never), false, String(bad));
});

test("settings schema: tracking and SEO fields are validated; blank is allowed (it clears the value); consent defaults to OFF", () => {
  const parse = (extra: Record<string, unknown>) => storeSettingsFormSchema.safeParse({ ...validBase(), ...extra });
  assert.equal(parse({}).success, true);
  const parsed = parse({ tiktokPixelId: "", linkedinPartnerId: "", seoTitleTemplate: "", ogImageUrl: "" });
  assert.ok(parsed.success);
  assert.equal(parsed.data.consentMode, "OFF");
  assert.equal(parse({ tiktokPixelId: "C1A2B3C4D5E6F7G8H9I0", linkedinPartnerId: "1234567", consentMode: "OPT_IN", ogImageUrl: "https://cdn.example.com/a.jpg" }).success, true);
  for (const bad of [{ tiktokPixelId: "bad id" }, { linkedinPartnerId: "abc" }, { consentMode: "MAYBE" }, { ogImageUrl: "javascript:alert(1)" }, { ogImageUrl: "http://" }, { seoDescription: "x".repeat(301) }, { seoTitleTemplate: "x".repeat(121) }]) {
    assert.equal(parse(bad).success, false, JSON.stringify(bad));
  }
});

function validBase() {
  return {
    storeName: "Gift Pacific", primaryColor: "#A63A5B", secondaryColor: "#F1E5D6", currencyCode: "BDT", currencySymbol: "৳",
    logoUrl: "", faviconUrl: "", instagramUrl: "", facebookUrl: "", whatsappUrl: "", tiktokUrl: "",
    deliveryChargeDhaka: 70, deliveryChargeOutsideDhaka: 100, deliveryChargeOther: 150, shippingFlatRate: 0, taxRatePercent: 0,
  };
}

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...realEnv }; });

function spyFetch() {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: String(init.body) }); return new Response("{}"); }) as never;
  return calls;
}

const sampleEvent = () =>
  buildPurchaseEvent({
    order: { orderNumber: "AP-1", total: 10, currency: "BDT", email: null, phone: "01712345678", userId: null, shipping: {}, items: [{ productId: "p1", quantity: 1, unitPrice: 10 }] },
    eventId: "purchase_AP-1",
    eventTime: new Date(),
    sourceUrl: "https://shop.test/checkout",
    attribution: { userAgent: "UA" },
  });

test("server-side Purchase: uses the pixel configured in Admin (not only the env var), and never sends the access token in the URL", async () => {
  const env = { META_CONVERSIONS_API_TOKEN: "TOKEN-123", NEXT_PUBLIC_META_PIXEL_ID: "111111" };
  const admin = resolveMetaConfig("222222", env);
  assert.ok(admin.ok);
  const calls = spyFetch();
  await sendMetaEvents(admin.config, [sampleEvent()]);
  assert.match(calls[0].url, /\/222222\/events$/);                        // the admin pixel wins over the env var
  assert.ok(!calls[0].url.includes("TOKEN-123"));
  assert.match(calls[0].body, /"event_source_url":"https:\/\/shop.test\/checkout"/);
  const fallback = resolveMetaConfig(null, env);
  assert.ok(fallback.ok && fallback.config.pixelId === "111111");            // falls back to the env var
});

test("server-side Purchase: no configuration is produced without a token or with a malformed pixel id", () => {
  assert.deepEqual(resolveMetaConfig("../../evil?x=", { META_CONVERSIONS_API_TOKEN: "T" }), { ok: false, reason: "invalid_pixel" });
  assert.deepEqual(resolveMetaConfig("222222", {}), { ok: false, reason: "no_token" });
  assert.deepEqual(resolveMetaConfig(null, { META_CONVERSIONS_API_TOKEN: "T" }), { ok: false, reason: "no_pixel" });
});

test("server-side tracking failures never throw (they must not break checkout)", async () => {
  globalThis.fetch = (async () => { throw new Error("network down"); }) as never;
  const cfg = resolveMetaConfig("222222", { META_CONVERSIONS_API_TOKEN: "T" });
  assert.ok(cfg.ok);
  const result = await sendMetaEvents(cfg.config, [sampleEvent()]);
  assert.equal(result.ok, false);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("REPO GUARD: no server secret is referenced by any client component (only public tracking ids reach the browser)", () => {
  const secrets = /(META_CONVERSIONS_API_TOKEN|GA4_API_SECRET|GOOGLE_CLIENT_SECRET|FACEBOOK_APP_SECRET|COURIER_API_SECRET|COURIER_API_KEY|COURIER_WEBHOOK_SECRET|AUTH_SECRET|CLOUDINARY_API_SECRET|process\.env\.DATABASE_URL)/;
  const offenders = walk(path.join(process.cwd(), "src"))
    .filter((f) => /^\s*["']use client["']/m.test(readFileSync(f, "utf8").slice(0, 400)))
    .filter((f) => secrets.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
  // and nothing exposes a secret through a NEXT_PUBLIC_ variable name
  const env = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.ok(!/NEXT_PUBLIC_[A-Z_]*(SECRET|TOKEN|PASSWORD|PRIVATE)/.test(env));
});
