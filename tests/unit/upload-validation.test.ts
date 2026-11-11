import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_DATA_URL_LENGTH, MAX_UPLOAD_BYTES, SERVER_ACTION_BODY_LIMIT_MB, isAppCloudinaryPublicId,
  validateImageDataUrl, validateImageFileClientSide,
} from "@/lib/upload-validation";

const b64 = (bytes: number[], pad = 0) => Buffer.from([...bytes, ...new Array(pad).fill(0)]).toString("base64");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0];

test("accepts real JPEG / PNG / WebP", () => {
  assert.deepEqual(validateImageDataUrl(`data:image/png;base64,${b64(PNG)}`), { ok: true, mime: "image/png", bytes: 16 });
  assert.equal(validateImageDataUrl(`data:image/jpeg;base64,${b64(JPG)}`).ok, true);
  assert.equal(validateImageDataUrl(`data:image/webp;base64,${b64(WEBP)}`).ok, true);
});

test("rejects SVG (even though it starts with data:image/) and other types", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
  for (const mime of ["image/svg+xml", "image/gif", "image/avif", "image/bmp", "text/html", "application/pdf"]) {
    assert.equal(validateImageDataUrl(`data:${mime};base64,${svg}`).ok, false, mime);
  }
});

test("rejects a declared type whose bytes don't match (polyglot / spoofed)", () => {
  assert.equal(validateImageDataUrl(`data:image/png;base64,${b64(JPG)}`).ok, false);
  const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  assert.equal(validateImageDataUrl(`data:image/png;base64,${html}`).ok, false);
});

test("rejects malformed input", () => {
  for (const v of [null, undefined, 5, "", "hello", "data:image/png;base64,", "data:image/png,abc", "data:image/png;base64,@@@@", "data:image/png;charset=x;base64,AAAA", "data:image/png;base64,AAA"]) {
    assert.equal(validateImageDataUrl(v).ok, false, String(v));
  }
});

test("enforces the 8MB limit", () => {
  const big = Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_UPLOAD_BYTES)]).toString("base64");
  assert.equal(validateImageDataUrl(`data:image/png;base64,${big}`).ok, false);
  const justUnder = Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_UPLOAD_BYTES - PNG.length)]).toString("base64");
  const r = validateImageDataUrl(`data:image/png;base64,${justUnder}`);
  assert.equal(r.ok, true);
});

test("server action body limit is NOT smaller than the largest legal upload", () => {
  assert.ok(SERVER_ACTION_BODY_LIMIT_MB * 1024 * 1024 >= MAX_DATA_URL_LENGTH);
  const cfg = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  const m = cfg.match(/bodySizeLimit:\s*"(\d+)mb"/);
  assert.ok(m, "next.config.ts must set serverActions.bodySizeLimit");
  assert.equal(Number(m![1]), SERVER_ACTION_BODY_LIMIT_MB);
});

test("client pre-check and cloudinary id guard", () => {
  assert.equal(validateImageFileClientSide({ type: "image/svg+xml", size: 10 }) !== null, true);
  assert.equal(validateImageFileClientSide({ type: "image/png", size: MAX_UPLOAD_BYTES + 1 }) !== null, true);
  assert.equal(validateImageFileClientSide({ type: "image/webp", size: 10 }), null);
  assert.equal(isAppCloudinaryPublicId("giftpacific/products/abc"), true);
  assert.equal(isAppCloudinaryPublicId("other-folder/abc"), false);
  assert.equal(isAppCloudinaryPublicId("giftpacific/../x"), false);
});
