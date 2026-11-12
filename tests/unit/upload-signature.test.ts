import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// The REAL signer (not the test stub): imported by relative path so the specifier map doesn't replace it.
process.env.CLOUDINARY_CLOUD_NAME = "democloud";
process.env.CLOUDINARY_API_KEY = "123456789012345";
process.env.CLOUDINARY_API_SECRET = "s3cr3t-value-that-must-never-leave-the-server";
type Signer = typeof import("../../src/lib/cloudinary/cloudinary").createSignedUploadParams;
let cached: Signer | null = null;
const createSignedUploadParams: Signer = (...args) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cached ??= require("../../src/lib/cloudinary/cloudinary").createSignedUploadParams as Signer;
  return cached(...args);
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

test("signature equals Cloudinary's documented algorithm: sha1(sorted 'k=v&k=v' + api_secret)", () => {
  const p = createSignedUploadParams("banners", "Summer Sale!");
  const expected = sha1(
    `allowed_formats=jpg,png,webp&folder=giftpacific/banners&public_id=${p.publicId}&timestamp=${p.timestamp}` +
      process.env.CLOUDINARY_API_SECRET,
  );
  assert.equal(p.signature, expected);
});

test("the API secret never appears in what is returned to the browser; the public key and URL are right", () => {
  const p = createSignedUploadParams("products", "Mug");
  const wire = JSON.stringify(p);
  assert.ok(!wire.includes(process.env.CLOUDINARY_API_SECRET!));
  assert.equal(p.apiKey, "123456789012345");
  assert.equal(p.uploadUrl, "https://api.cloudinary.com/v1_1/democloud/image/upload");
  assert.ok(wire.length < 500, "a tiny descriptor: no image data travels through the Server Action");
});

test("folder structure and readable public id are exactly as before", () => {
  const p = createSignedUploadParams("products", "Blue Ceramic Mug!");
  assert.equal(p.folder, "giftpacific/products");
  assert.match(p.publicId!, /^blue-ceramic-mug-[0-9a-f]{8}$/);
  for (const folder of ["products", "banners", "branding", "categories", "team", "boxes"] as const) {
    assert.equal(createSignedUploadParams(folder).folder, `giftpacific/${folder}`);
  }
});

test("without a name hint no public_id is signed (Cloudinary generates one); the signature still matches", () => {
  const p = createSignedUploadParams("team");
  assert.equal(p.publicId, undefined);
  assert.equal(
    p.signature,
    sha1(`allowed_formats=jpg,png,webp&folder=giftpacific/team&timestamp=${p.timestamp}` + process.env.CLOUDINARY_API_SECRET),
  );
});

test("no transformation / eager / resize parameter is signed: the original is stored untouched", () => {
  const p = createSignedUploadParams("banners", "x");
  assert.deepEqual(Object.keys(p).sort(), ["allowedFormats", "apiKey", "folder", "publicId", "signature", "timestamp", "uploadUrl"]);
});

test("hostile name hints are slugified (no path traversal / injection into the public id)", () => {
  const p = createSignedUploadParams("products", "../../etc/passwd&folder=evil");
  assert.match(p.publicId!, /^[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.ok(!p.publicId!.includes("/") && !p.publicId!.includes("&"));
});
