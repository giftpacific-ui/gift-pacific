import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assetToDiscard, imageForSave, initialImageState, isCloudinaryUrl } from "@/lib/campaign-image";

const CLD = "https://res.cloudinary.com/demo/image/upload/v1/giftpacific/banners/x.jpg";

test("create: no saved image -> empty uploader and empty URL field", () => {
  assert.deepEqual(initialImageState(null), { uploaded: null, urlText: "" });
  assert.deepEqual(initialImageState(undefined), { uploaded: null, urlText: "" });
  assert.equal(imageForSave(initialImageState(null)), "");
});

test("edit: a saved Cloudinary image is displayed in the uploader (public id unknown)", () => {
  const s = initialImageState(CLD);
  assert.deepEqual(s.uploaded, { url: CLD, publicId: null });
  assert.equal(s.urlText, "");
  assert.equal(imageForSave(s), CLD); // unchanged re-save keeps the image
});

test("edit: an older hand-typed URL stays in the URL field and is saved unchanged", () => {
  for (const url of ["https://picsum.photos/seed/a/800/600", "https://example.com/hero.jpg", "http://legacy.test/a.png"]) {
    const s = initialImageState(url);
    assert.equal(s.uploaded, null, "never previewed through next/image in the admin form");
    assert.equal(s.urlText, url);
    assert.equal(imageForSave(s), url);
  }
  assert.equal(isCloudinaryUrl("https://res.cloudinary.com.evil.test/x.jpg"), false);
  assert.equal(isCloudinaryUrl("http://res.cloudinary.com/x.jpg"), false);
});

test("an uploaded image wins over the URL field; removing it falls back to the URL field (or nothing)", () => {
  assert.equal(imageForSave({ uploaded: { url: CLD, publicId: "giftpacific/banners/x" }, urlText: "https://old.test/a.jpg" }), CLD);
  assert.equal(imageForSave({ uploaded: null, urlText: "  https://old.test/a.jpg  " }), "https://old.test/a.jpg");
  assert.equal(imageForSave({ uploaded: null, urlText: "" }), "");
});

test("only an image uploaded in this session is ever discarded; a saved image is never touched", () => {
  const session = { url: CLD, publicId: "giftpacific/banners/x" };
  const saved = { url: CLD, publicId: null };
  const other = { url: CLD + "?2", publicId: "giftpacific/banners/y" };
  assert.deepEqual(assetToDiscard(session, other), session); // replaced
  assert.deepEqual(assetToDiscard(session, null), session); // removed
  assert.equal(assetToDiscard(saved, other), null); // replacing a SAVED image deletes nothing
  assert.equal(assetToDiscard(saved, null), null);
  assert.equal(assetToDiscard(session, session), null); // unchanged
  assert.equal(assetToDiscard(null, other), null);
});

test("campaign form reuses the shared uploader pipeline and has no base64 / file-through-action path", () => {
  const form = readFileSync("src/features/admin/campaign-manager.tsx", "utf8");
  assert.match(form, /<SingleImageUploader/);
  assert.match(form, /folder="banners"/); // an existing, allow-listed folder: server restrictions unchanged
  assert.match(form, /\bdeferDelete\b/); // the uploader's unconditional delete never runs; the safe discard action does
  assert.match(form, /discardUnsavedUploadAction/);
  assert.ok(!/FileReader|readAsDataURL|base64|data:image|\bFormData\b|\bnew File\b/.test(form));
  // the Server Action receives only strings (URL), never file content
  const action = readFileSync("src/server/actions/admin-campaign.actions.ts", "utf8");
  assert.match(action, /image\?: string;/);
  assert.ok(!/\b(File|Blob|ArrayBuffer|base64)\b/.test(action));
});

test("the shared pipeline is unchanged: no second upload architecture was added for campaigns", () => {
  const callers = ["src/features/admin/campaign-manager.tsx", "src/lib/campaign-image.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(!/api\.cloudinary\.com|uploadFileToCloudinary|createSignedUploadParams|cloudinary\.utils/.test(callers));
});
