import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getActiveCampaign, getCampaignProducts } from "@/server/services/campaign.service";
import { addCampaignProductAction, deleteCampaignAction, removeCampaignProductAction, saveCampaignAction, searchProductsForCampaignAction } from "@/server/actions/admin-campaign.actions";
import { saveBannerAction } from "@/server/actions/admin-settings.actions";
import { saveCouponAction } from "@/server/actions/admin-coupon.actions";
import { getActiveBanners } from "@/server/services/product.service";
import { FORBIDDEN_PUBLIC_PRODUCT_KEYS } from "@/lib/product-dto";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedCatalog(db); });
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const NOW = new Date("2026-10-10T10:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function campaign(o: Record<string, unknown> = {}) {
  return db.insert("collection", { id: `c${db.rows("collection").length + 1}`, name: "Eid Sale", slug: `eid-${db.rows("collection").length}`, isCampaign: true, isActive: true, startsAt: null, endsAt: null, createdAt: new Date(), ...o });
}
const link = (collectionId: string, productId: string) => db.insert("productCollection", { collectionId, productId });

test("only an active campaign inside its window is shown", async () => {
  assert.equal(await getActiveCampaign(NOW), null);
  campaign({ id: "inactive", isActive: false });
  campaign({ id: "future", startsAt: day(2) });
  campaign({ id: "expired", endsAt: day(-1) });
  db.insert("collection", { id: "plain", name: "Not a campaign", slug: "plain", isCampaign: false, isActive: true });
  assert.equal(await getActiveCampaign(NOW), null);
  campaign({ id: "live", startsAt: day(-1), endsAt: day(3), createdAt: new Date("2026-10-01") });
  assert.equal((await getActiveCampaign(NOW))!.id, "live");
  campaign({ id: "newer", createdAt: new Date("2026-10-05") }); // overlapping: most recently created wins
  assert.equal((await getActiveCampaign(NOW))!.id, "newer");
  assert.deepEqual(Object.keys((await getActiveCampaign(NOW))!).sort(), ["description", "endsAt", "id", "image", "name"]);
});

test("campaign products: only ACTIVE members, public DTO only, no internal fields", async () => {
  const c = campaign({ id: "live" });
  campaign({ id: "other", slug: "other" });
  link("live", "p-standard"); link("live", "p-variant"); link("other", "p-pers");
  db.insert("product", { id: "p-draft", name: "Draft", slug: "draft", status: "DRAFT", price: 5, stock: 1 });
  link("live", "p-draft");
  const res = await getCampaignProducts(c.id);
  assert.deepEqual(res.items.map((p) => p.id).sort(), ["p-standard", "p-variant"]);
  const json = JSON.stringify(res);
  for (const f of FORBIDDEN_PUBLIC_PRODUCT_KEYS) assert.ok(!json.includes(`"${f}"`), `leaked ${f}`);
  assert.ok(!json.includes("costPrice"));
  assert.equal(res.items.find((p) => p.id === "p-variant")!.availability.inStock, true);
});

test("admin campaign management requires admin and validates input", async () => {
  const raw = { name: "Winter Sale", slug: "winter-sale", description: "d", image: "", isActive: true, startsAt: "2026-12-01", endsAt: "2026-12-31" };
  await assert.rejects(runAs(null, () => saveCampaignAction(null, raw)), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "u" }, () => addCampaignProductAction("x", "p-standard")), /FORBIDDEN/);
  assert.equal((await admin(() => saveCampaignAction(null, { ...raw, slug: "Bad Slug" }))).success, false);
  assert.equal((await admin(() => saveCampaignAction(null, { ...raw, image: "javascript:alert(1)" }))).success, false);
  assert.equal((await admin(() => saveCampaignAction(null, { ...raw, startsAt: "2026-12-31", endsAt: "2026-12-01" }))).success, false);
  assert.equal((await admin(() => saveCampaignAction(null, { ...raw, startsAt: "nope" }))).success, false);
  assert.equal(db.rows("collection").length, 0);
  assert.equal((await admin(() => saveCampaignAction(null, raw))).success, true);
  const saved = db.rows("collection")[0];
  assert.equal(saved.isCampaign, true);
  assert.equal(saved.endsAt.toISOString(), "2026-12-31T17:59:59.999Z"); // inclusive end of day in Dhaka
  assert.equal((await admin(() => saveCampaignAction(null, raw))).success, false); // duplicate slug, friendly message
  assert.equal((await admin(() => saveCampaignAction(saved.id, { ...raw, name: "Winter Sale 2" }))).success, true);
  assert.equal(db.get("collection", saved.id).name, "Winter Sale 2");
});

test("only campaigns can be edited/deleted here; membership changes are scoped and idempotent", async () => {
  db.insert("collection", { id: "plain", name: "Plain collection", slug: "plain", isCampaign: false, isActive: true });
  const raw = { name: "Hijack", slug: "hijack", isActive: true };
  assert.equal((await admin(() => saveCampaignAction("plain", raw))).success, false);
  assert.equal((await admin(() => deleteCampaignAction("plain"))).success, false);
  assert.equal(db.get("collection", "plain").name, "Plain collection");
  assert.equal((await admin(() => addCampaignProductAction("plain", "p-standard"))).success, false);
  const c = campaign({ id: "live" });
  assert.equal((await admin(() => addCampaignProductAction(c.id, "ghost"))).success, false);
  assert.equal((await admin(() => addCampaignProductAction(c.id, "p-standard"))).success, true);
  assert.equal((await admin(() => addCampaignProductAction(c.id, "p-standard"))).success, true); // already there: no-op
  assert.equal(db.rows("productCollection").length, 1);
  assert.equal((await admin(() => removeCampaignProductAction(c.id, "p-standard"))).success, true);
  assert.equal(db.rows("productCollection").length, 0);
  assert.deepEqual((await admin(() => searchProductsForCampaignAction("clay"))).map((p: { name: string }) => p.name).sort(), ["Clay Mug", "Clay Vase"]);
  assert.deepEqual(await admin(() => searchProductsForCampaignAction("  ")), []);
  assert.equal((await admin(() => deleteCampaignAction(c.id))).success, true);
});

const bannerRaw = (o = {}) => ({ title: "Big Sale", subtitle: "", imageUrl: "https://res.cloudinary.com/x/b.png", cloudinaryPublicId: null, ctaLabel: "Go", ctaHref: "/shop", placement: "HERO", sortOrder: 0, isActive: true, startsAt: "", endsAt: "", ...o });

test("campaign banner always links to /campaign; popup & campaign placements are accepted; unsafe links rejected", async () => {
  assert.equal((await admin(() => saveBannerAction(null, bannerRaw({ placement: "CAMPAIGN", ctaHref: "https://evil.example" })))).success, true);
  assert.equal(db.rows("banner")[0].ctaHref, "/campaign");
  assert.equal((await admin(() => saveBannerAction(null, bannerRaw({ placement: "POPUP", ctaHref: "/shop" })))).success, true);
  assert.equal(db.rows("banner")[1].placement, "POPUP");
  assert.equal((await admin(() => saveBannerAction(null, bannerRaw({ placement: "POPUP", ctaHref: "javascript:alert(1)" })))).success, false);
  assert.equal((await admin(() => saveBannerAction(null, bannerRaw({ placement: "NOPE" })))).success, false);
  assert.equal((await admin(() => saveBannerAction(null, bannerRaw({ startsAt: "2026-05-02", endsAt: "2026-05-01" })))).success, false);
});

test("banner scheduling: inclusive end date (Dhaka) and start gating", async () => {
  await admin(() => saveBannerAction(null, bannerRaw({ placement: "POPUP", startsAt: "2026-10-10", endsAt: "2026-10-10" })));
  const at = async (iso: string) => {
    const RealDate = Date;
    // freeze "now" for getActiveBanners
    (globalThis as { Date: unknown }).Date = class extends RealDate { constructor(...a: unknown[]) { super(...(a.length ? (a as [string]) : [iso])); } static now() { return new RealDate(iso).getTime(); } } as unknown as DateConstructor;
    try { return (await getActiveBanners("POPUP")).length; } finally { (globalThis as { Date: unknown }).Date = RealDate; }
  };
  assert.equal(await at("2026-10-09T17:00:00Z"), 0); // before 00:00 Dhaka on the 10th
  assert.equal(await at("2026-10-10T12:00:00Z"), 1);
  assert.equal(await at("2026-10-10T17:30:00Z"), 1); // 23:30 Dhaka, last day: still live
  assert.equal(await at("2026-10-10T18:30:00Z"), 0);
});

test("coupon end dates are inclusive too", async () => {
  const res = await admin(() => saveCouponAction(null, { code: "EID", type: "FIXED", value: 50, minPurchase: "", maxDiscount: "", usageLimit: "", perUserLimit: "", startsAt: "2026-10-01", endsAt: "2026-10-31", isActive: true }));
  assert.equal(res.success, true);
  assert.equal(db.rows("coupon")[0].endsAt.toISOString(), "2026-10-31T17:59:59.999Z");
});
