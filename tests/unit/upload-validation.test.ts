import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUDINARY_ALLOWED_FORMATS, detectMime, isAppCloudinaryPublicId, validateImageFileClientSide, validateImageFileSignature,
} from "@/lib/upload-validation";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0];
const file = (bytes: number[], type: string) => new Blob([new Uint8Array(bytes)], { type });

test("accepts real JPEG / PNG / WebP by type and leading bytes", async () => {
  assert.equal(await validateImageFileSignature(file(PNG, "image/png")), null);
  assert.equal(await validateImageFileSignature(file(JPG, "image/jpeg")), null);
  assert.equal(await validateImageFileSignature(file(WEBP, "image/webp")), null);
  assert.equal(detectMime(new Uint8Array(PNG)), "image/png");
});

test("rejects SVG and other types, and a declared type whose bytes don't match", async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  for (const type of ["image/svg+xml", "image/gif", "image/avif", "image/bmp", "text/html", "application/pdf"]) {
    assert.notEqual(await validateImageFileSignature(new Blob([svg], { type })), null, type);
  }
  assert.notEqual(await validateImageFileSignature(file(JPG, "image/png")), null); // spoofed
  assert.notEqual(await validateImageFileSignature(new Blob([svg], { type: "image/png" })), null); // polyglot
});

test("there is NO application-level size cap: a 5 GB 'file' passes the client pre-check", () => {
  assert.equal(validateImageFileClientSide({ type: "image/png", size: 5 * 1024 ** 3 } as never), null);
  assert.equal(validateImageFileClientSide({ type: "image/jpeg" }), null);
  assert.notEqual(validateImageFileClientSide({ type: "image/svg+xml" }), null);
});

test("signature check reads only the first 16 bytes, never the whole file", async () => {
  let sliced: [number, number] | null = null;
  const real = file(PNG, "image/png");
  const spy = {
    type: "image/png",
    slice(a: number, b: number) { sliced = [a, b]; return real.slice(a, b); },
    arrayBuffer() { throw new Error("must not read the entire file"); },
  } as unknown as Blob & { type: string };
  assert.equal(await validateImageFileSignature(spy), null);
  assert.deepEqual(sliced, [0, 16]);
});

test("Cloudinary allowed formats match the MIME allow-list; app folder guard unchanged", () => {
  assert.equal(CLOUDINARY_ALLOWED_FORMATS, "jpg,png,webp");
  assert.equal(isAppCloudinaryPublicId("giftpacific/products/abc"), true);
  assert.equal(isAppCloudinaryPublicId("other-folder/abc"), false);
  assert.equal(isAppCloudinaryPublicId("giftpacific/../x"), false);
});
