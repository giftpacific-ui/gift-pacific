import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import loader, { OPTIMIZER_HOSTS, cloudinaryDeliveryUrl, isUnlistedExternalHttpsUrl } from "@/lib/cloudinary/image-loader";
import nextConfig from "../../next.config";

const BASE = "https://res.cloudinary.com/demo/image/upload";

test("Cloudinary originals are delivered with f_auto, q_auto and a responsive width (never upscaled)", () => {
  assert.equal(
    loader({ src: `${BASE}/v1699999999/giftpacific/products/mug-ab12cd34.jpg`, width: 828 }),
    `${BASE}/f_auto,q_auto,c_limit,w_828/v1699999999/giftpacific/products/mug-ab12cd34.jpg`,
  );
  // works without a version segment too
  assert.equal(
    cloudinaryDeliveryUrl(`${BASE}/giftpacific/banners/b1.webp`, 1920),
    `${BASE}/f_auto,q_auto,c_limit,w_1920/giftpacific/banners/b1.webp`,
  );
});

test("an existing crop/resize transformation in a stored URL is kept and ours is applied after it", () => {
  assert.equal(
    cloudinaryDeliveryUrl(`${BASE}/c_fill,w_800,h_400,g_auto/v12/giftpacific/banners/b.png`, 640),
    `${BASE}/c_fill,w_800,h_400,g_auto/f_auto,q_auto,c_limit,w_640/v12/giftpacific/banners/b.png`,
  );
  assert.equal(
    cloudinaryDeliveryUrl(`${BASE}/c_fill,w_800/e_sharpen/v12/giftpacific/x.png`, 256),
    `${BASE}/c_fill,w_800/e_sharpen/f_auto,q_auto,c_limit,w_256/v12/giftpacific/x.png`,
  );
});

test("a folder/public-id segment is never mistaken for a transformation", () => {
  const out = cloudinaryDeliveryUrl(`${BASE}/giftpacific/products/my-image.png`, 384)!;
  assert.ok(out.endsWith("/giftpacific/products/my-image.png"));
  assert.equal(out.split("/f_auto").length, 2);
});

test("non-Cloudinary and local images keep the normal Next.js optimizer path", () => {
  assert.equal(
    loader({ src: "https://picsum.photos/seed/a/800/600", width: 640 }),
    `/_next/image?url=${encodeURIComponent("https://picsum.photos/seed/a/800/600")}&w=640&q=75`,
  );
  assert.equal(loader({ src: "/file.svg", width: 64, quality: 75 }), "/_next/image?url=%2Ffile.svg&w=64&q=75");
  // lookalike hosts are not treated as Cloudinary
  assert.equal(cloudinaryDeliveryUrl("https://res.cloudinary.com.evil.test/demo/image/upload/a.jpg", 100), null);
  assert.equal(cloudinaryDeliveryUrl("http://res.cloudinary.com/demo/image/upload/a.jpg", 100), null);
  assert.equal(cloudinaryDeliveryUrl("https://res.cloudinary.com/demo/video/upload/a.mp4", 100), null);
});

test("next.config.ts wires the loader file and no longer carries the base64-upload body limit", () => {
  const cfg = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(cfg, /loaderFile:\s*"\.\/src\/lib\/cloudinary\/image-loader\.ts"/);
  assert.ok(!/bodySizeLimit/.test(cfg));
  // `loader: "custom"` would make Next return 404 for /_next/image, silently un-optimising every non-Cloudinary image
  // (verified at runtime). Keep the default loader and supply only the loaderFile.
  assert.ok(!/^\s*loader\s*:/m.test(cfg), 'images.loader must not be set (setting it disables the built-in optimizer)');
});

test("legacy https images on hosts the optimizer does not allow are passed straight to the browser (no HTTP 400)", () => {
  for (const src of ["https://example.com/legacy-banner.jpg", "https://cdn.some-shop.com/a/b.png", "https://a.b.supabase.co/x.png"]) { // two labels: "*" matches ONE label, as in Next.js
    assert.equal(isUnlistedExternalHttpsUrl(src), true, src);
    assert.equal(loader({ src, width: 640 }), src, src);
  }
});

test("allow-listed hosts, local paths and non-https URLs keep the optimizer path; Cloudinary keeps its own", () => {
  assert.equal(loader({ src: "https://images.unsplash.com/photo-1", width: 256 }), `/_next/image?url=${encodeURIComponent("https://images.unsplash.com/photo-1")}&w=256&q=75`);
  assert.equal(loader({ src: "https://abc.supabase.co/storage/x.png", width: 256 }).startsWith("/_next/image?"), true);
  assert.equal(loader({ src: "/img/login-bg.png", width: 640 }).startsWith("/_next/image?"), true);
  assert.equal(loader({ src: "http://legacy.test/a.png", width: 640 }).startsWith("/_next/image?"), true);
  assert.ok(loader({ src: "https://res.cloudinary.com/demo/image/upload/v1/x.jpg", width: 640 }).includes("f_auto,q_auto,c_limit,w_640"));
  // a lookalike of an allowed host is NOT treated as allowed
  assert.equal(isUnlistedExternalHttpsUrl("https://picsum.photos.evil.test/a.jpg"), true);
  assert.equal(isUnlistedExternalHttpsUrl("https://evilpicsum.photos/a.jpg"), true);
});

test("the loader and next.config.ts share ONE allow-list (image-hosts.json); the optimizer allow-list is not widened", () => {
  const patterns = (nextConfig.images?.remotePatterns ?? []) as { protocol?: string; hostname: string }[];
  assert.deepEqual(patterns.map((p) => p.hostname), [...OPTIMIZER_HOSTS]);
  assert.ok(patterns.every((p) => p.protocol === "https"));
  assert.deepEqual([...OPTIMIZER_HOSTS], ["picsum.photos", "fastly.picsum.photos", "res.cloudinary.com", "*.supabase.co", "images.unsplash.com", "img.youtube.com", "i.ytimg.com", "*.fbcdn.net"]);
  // no stock/placeholder host names are hard-coded anywhere in src (storefront guard)
  assert.ok(!/picsum|unsplash/i.test(readFileSync("src/lib/cloudinary/image-loader.ts", "utf8")));
});
