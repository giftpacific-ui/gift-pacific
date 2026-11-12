import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getActiveCampaign } from "@/server/services/campaign.service";
import { saveCampaignAction } from "@/server/actions/admin-campaign.actions";
import { createUploadSignatureAction, discardUnsavedUploadAction } from "@/server/actions/upload.actions";

let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedCatalog(db);
  (globalThis as { __TEST_DELETES__?: string[] }).__TEST_DELETES__ = [];
  (globalThis as { __TEST_UPLOADS__?: unknown[] }).__TEST_UPLOADS__ = [];
});
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const deletes = () => (globalThis as { __TEST_DELETES__?: string[] }).__TEST_DELETES__ ?? [];

const UPLOADED_A = "https://res.cloudinary.com/demo/image/upload/v1/giftpacific/banners/eid-sale-a1b2c3d4.jpg";
const UPLOADED_B = "https://res.cloudinary.com/demo/image/upload/v2/giftpacific/banners/eid-sale-e5f6a7b8.webp";
const base = { name: "Eid Sale", slug: "eid-sale", description: "d", isActive: true, startsAt: "", endsAt: "" };

test("create with an uploaded Cloudinary URL persists exactly that URL, and the public campaign returns it", async () => {
  const res = await admin(() => saveCampaignAction(null, { ...base, image: UPLOADED_A }));
  assert.equal(res.success, true);
  const row = db.rows("collection")[0];
  assert.equal(row.image, UPLOADED_A);
  assert.equal(row.isCampaign, true);
  const pub = await getActiveCampaign(new Date());
  assert.equal(pub?.image, UPLOADED_A); // what the homepage section and /campaign render
});

test("edit replaces the image; the old URL is gone and only the new one is stored", async () => {
  await admin(() => saveCampaignAction(null, { ...base, image: UPLOADED_A }));
  const id = db.rows("collection")[0].id;
  assert.equal((await admin(() => saveCampaignAction(id, { ...base, image: UPLOADED_B }))).success, true);
  assert.equal(db.get("collection", id).image, UPLOADED_B);
  assert.equal(db.rows("collection").length, 1);
});

test("removing the image stores null (the model's optional image) and the campaign still works", async () => {
  await admin(() => saveCampaignAction(null, { ...base, image: UPLOADED_A }));
  const id = db.rows("collection")[0].id;
  assert.equal((await admin(() => saveCampaignAction(id, { ...base, image: "" }))).success, true);
  assert.equal(db.get("collection", id).image, null);
  assert.equal((await getActiveCampaign(new Date()))?.image, null);
});

test("existing campaigns with manually entered URLs keep their URL when re-saved unchanged", async () => {
  for (const [i, legacy] of ["https://picsum.photos/seed/eid/1983/793", "https://images.unsplash.com/photo-1", "https://example.com/banner.jpg"].entries()) {
    const id = `legacy${i}`;
    db.insert("collection", { id, name: `Old ${i}`, slug: `old-${i}`, isCampaign: true, isActive: true, image: legacy, createdAt: new Date() });
    // The form round-trips the saved URL untouched (lib/campaign-image.ts) -> the same string comes back to the action.
    assert.equal((await admin(() => saveCampaignAction(id, { name: `Old ${i}`, slug: `old-${i}`, isActive: true, image: legacy }))).success, true);
    assert.equal(db.get("collection", id).image, legacy);
  }
});

test("a manually entered URL can still be replaced by an uploaded image and vice versa", async () => {
  db.insert("collection", { id: "c1", name: "Old", slug: "old", isCampaign: true, isActive: true, image: "https://example.com/x.jpg", createdAt: new Date() });
  await admin(() => saveCampaignAction("c1", { name: "Old", slug: "old", isActive: true, image: UPLOADED_A }));
  assert.equal(db.get("collection", "c1").image, UPLOADED_A);
  await admin(() => saveCampaignAction("c1", { name: "Old", slug: "old", isActive: true, image: "https://example.com/y.jpg" }));
  assert.equal(db.get("collection", "c1").image, "https://example.com/y.jpg");
});

test("there is no base64 path: data URLs and scripts are rejected and nothing is stored", async () => {
  for (const bad of ["data:image/png;base64,iVBORw0KGgo=", "javascript:alert(1)", "blob:https://x/y", "file:///etc/passwd", "ftp://x/y.png"]) {
    const res = await admin(() => saveCampaignAction(null, { ...base, image: bad }));
    assert.equal(res.success, false, bad);
  }
  assert.equal(db.rows("collection").length, 0);
});

test("saving a campaign is admin-only, including with an image", async () => {
  await assert.rejects(runAs(null, () => saveCampaignAction(null, { ...base, image: UPLOADED_A })), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "u" }, () => saveCampaignAction(null, { ...base, image: UPLOADED_A })), /FORBIDDEN/);
  assert.equal(db.rows("collection").length, 0);
});

test("campaign uploads use the existing signed-upload action with an allowed folder, and carry no file data", async () => {
  const sig = await admin(() => createUploadSignatureAction("banners", "Eid Sale"));
  assert.equal(sig.success, true);
  if (sig.success) {
    assert.equal(sig.folder, "giftpacific/banners");
    assert.equal(sig.allowedFormats, "jpg,png,webp");
    assert.ok(JSON.stringify(sig).length < 500);
    assert.ok(!/secret/i.test(JSON.stringify(sig)));
  }
  await assert.rejects(runAs(null, () => createUploadSignatureAction("banners")), /FORBIDDEN/);
});

test("replacing/removing an image uploaded this session discards it - unless a saved campaign references it", async () => {
  const idA = "giftpacific/banners/eid-sale-a1b2c3d4";
  // not referenced by any record: discarded
  const r1 = await admin(() => discardUnsavedUploadAction(idA, UPLOADED_A));
  assert.deepEqual(r1, { success: true, deleted: true });
  assert.deepEqual(deletes(), [idA]);
  // referenced by a saved campaign: kept
  await admin(() => saveCampaignAction(null, { ...base, image: UPLOADED_B }));
  const idB = "giftpacific/banners/eid-sale-e5f6a7b8";
  const r2 = await admin(() => discardUnsavedUploadAction(idB, UPLOADED_B));
  assert.deepEqual(r2, { success: true, deleted: false });
  assert.deepEqual(deletes(), [idA]); // still only A
  // ids outside this app's folder can never be deleted
  const r3 = await admin(() => discardUnsavedUploadAction("someone-else/x", UPLOADED_A));
  assert.equal(r3.success, false);
  await assert.rejects(runAs(null, () => discardUnsavedUploadAction(idA, UPLOADED_A)), /FORBIDDEN/);
});
