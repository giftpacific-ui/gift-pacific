import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs } from "../setup/helpers";
import { getStoreSettings, updateStoreSettings } from "@/server/services/admin-settings.service";

beforeEach(() => { freshDb(); });

test("tracking ids can be set, changed AND CLEARED (null clears, undefined leaves unchanged)", () => runAs(null, async () => {
  await updateStoreSettings({ storeName: "Gift Pacific", gtmId: "GTM-ABC1234", metaPixelId: "123456", tiktokPixelId: "C1A2B3C4D5E6F7G8H9I0", linkedinPartnerId: "1234567", consentMode: "OPT_IN" } as never);
  let s = await getStoreSettings();
  assert.deepEqual([s.gtmId, s.metaPixelId, s.tiktokPixelId, s.linkedinPartnerId, s.consentMode], ["GTM-ABC1234", "123456", "C1A2B3C4D5E6F7G8H9I0", "1234567", "OPT_IN"]);
  await updateStoreSettings({ storeName: "Gift Pacific" } as never);                              // untouched fields stay
  s = await getStoreSettings();
  assert.deepEqual([s.gtmId, s.tiktokPixelId, s.consentMode], ["GTM-ABC1234", "C1A2B3C4D5E6F7G8H9I0", "OPT_IN"]);
  await updateStoreSettings({ storeName: "Gift Pacific", gtmId: null, metaPixelId: null, tiktokPixelId: null, linkedinPartnerId: null, consentMode: "OFF" } as never);
  s = await getStoreSettings();
  assert.deepEqual([s.gtmId, s.metaPixelId, s.tiktokPixelId, s.linkedinPartnerId, s.consentMode], [null, null, null, null, "OFF"]);
}));

test("SEO settings are stored and can be cleared", () => runAs(null, async () => {
  await updateStoreSettings({ storeName: "Gift Pacific", seoTitleTemplate: "%s · Gift Pacific", seoDescription: "Gifts", ogImageUrl: "https://cdn.example.com/og.jpg" } as never);
  assert.equal((await getStoreSettings()).seoTitleTemplate, "%s · Gift Pacific");
  await updateStoreSettings({ storeName: "Gift Pacific", seoTitleTemplate: null, seoDescription: null, ogImageUrl: null } as never);
  const s = await getStoreSettings();
  assert.deepEqual([s.seoTitleTemplate, s.seoDescription, s.ogImageUrl], [null, null, null]);
}));
