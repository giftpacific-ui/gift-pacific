import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_SIZE_BYTES, CHUNK_THRESHOLD_BYTES, CloudinaryUploadError, uploadFileToCloudinary,
} from "@/lib/cloudinary/browser-upload";

const sig = {
  uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
  apiKey: "key123", timestamp: 1700000000, signature: "sig123",
  folder: "giftpacific/banners", publicId: "summer-sale-ab12cd34", allowedFormats: "jpg,png,webp",
};
const okJson = (over = {}) => ({
  secure_url: "https://res.cloudinary.com/demo/image/upload/v1/giftpacific/banners/summer-sale-ab12cd34.png",
  public_id: "giftpacific/banners/summer-sale-ab12cd34", format: "png", bytes: 1, ...over,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; body: FormData; headers: Record<string, string> };
function recorder(handler: (n: number, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, body: init.body as FormData, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return handler(calls.length, call);
  };
  return { calls, fetchImpl };
}
const blob = (bytes: number, type = "image/png") => Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name: "photo.png" });

test("small image: ONE multipart request carrying the File itself (no base64, no data URL)", async () => {
  const { calls, fetchImpl } = recorder(() => json(okJson()));
  const f = blob(300_000);
  const res = await uploadFileToCloudinary(f, sig, fetchImpl);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, sig.uploadUrl);
  assert.ok(c.body instanceof FormData);
  const sent = c.body.get("file");
  assert.ok(sent instanceof Blob, "the file part is a Blob/File, not a string");
  assert.equal((sent as Blob).size, 300_000);
  for (const [k, v] of c.body.entries()) {
    if (typeof v === "string") assert.ok(!v.startsWith("data:") && v.length < 200, `field ${k} must be a short string`);
  }
  assert.deepEqual(
    ["api_key", "timestamp", "signature", "folder", "allowed_formats", "public_id"].map((k) => c.body.get(k)),
    ["key123", "1700000000", "sig123", "giftpacific/banners", "jpg,png,webp", "summer-sale-ab12cd34"],
  );
  assert.ok(!c.body.has("api_secret"));
  assert.equal(res.publicId, "giftpacific/banners/summer-sale-ab12cd34");
  assert.ok(res.url.startsWith("https://res.cloudinary.com/"));
});

test("no resize/compress/transform parameter is ever sent: the original is preserved", async () => {
  const { calls, fetchImpl } = recorder(() => json(okJson()));
  await uploadFileToCloudinary(blob(1000), sig, fetchImpl);
  const keys = [...calls[0].body.keys()].sort();
  assert.deepEqual(keys, ["allowed_formats", "api_key", "file", "folder", "public_id", "signature", "timestamp"]);
});

test("exactly at the chunk threshold is still a single request; just above is chunked", async () => {
  let r = recorder(() => json(okJson()));
  await uploadFileToCloudinary(blob(CHUNK_THRESHOLD_BYTES), sig, r.fetchImpl);
  assert.equal(r.calls.length, 1);
  r = recorder((n) => (n < 2 ? json({ done: false }) : json(okJson())));
  await uploadFileToCloudinary(blob(CHUNK_THRESHOLD_BYTES + 1), sig, r.fetchImpl);
  assert.equal(r.calls.length, 2);
});

test("large file (45 MiB): chunked with correct Content-Range, one upload id, same signed params per chunk", async () => {
  const total = 45 * 1024 * 1024;
  const { calls, fetchImpl } = recorder((n) => (n < 3 ? json({ done: false }) : json(okJson({ bytes: total }))));
  const res = await uploadFileToCloudinary(blob(total), sig, fetchImpl);
  assert.equal(calls.length, 3);
  const ids = new Set(calls.map((c) => c.headers["X-Unique-Upload-Id"]));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.map((c) => c.headers["Content-Range"]), [
    `bytes 0-${CHUNK_SIZE_BYTES - 1}/${total}`,
    `bytes ${CHUNK_SIZE_BYTES}-${2 * CHUNK_SIZE_BYTES - 1}/${total}`,
    `bytes ${2 * CHUNK_SIZE_BYTES}-${total - 1}/${total}`,
  ]);
  const sizes = calls.map((c) => (c.body.get("file") as Blob).size);
  assert.equal(sizes.reduce((a, b) => a + b, 0), total);
  for (const c of calls) for (const k of ["api_key", "timestamp", "signature", "folder", "allowed_formats", "public_id"]) {
    assert.equal(c.body.get(k), calls[0].body.get(k));
  }
  assert.equal(res.bytes, total);
});

test("very large file (105 MiB, 6 chunks) completes", async () => {
  const total = 105 * 1024 * 1024;
  const { calls, fetchImpl } = recorder((n) => (n < 6 ? json({ done: false }) : json(okJson())));
  await uploadFileToCloudinary(blob(total), sig, fetchImpl);
  assert.equal(calls.length, 6);
  assert.equal(calls[5].headers["Content-Range"], `bytes ${5 * CHUNK_SIZE_BYTES}-${total - 1}/${total}`);
});

test("a chunk that hits a network error or HTTP 5xx is retried and the upload still succeeds", async () => {
  const total = 25 * 1024 * 1024;
  let n = 0;
  const calls: string[] = [];
  const fetchImpl = async (_u: string, init: RequestInit) => {
    n++;
    calls.push((init.headers as Record<string, string>)["Content-Range"]);
    if (n === 1) throw new TypeError("network down");
    if (n === 2) return json({ error: { message: "busy" } }, 503);
    return n === 3 ? json({ done: false }) : json(okJson());
  };
  const res = await uploadFileToCloudinary(blob(total), sig, fetchImpl);
  assert.equal(res.publicId, "giftpacific/banners/summer-sale-ab12cd34");
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[1], calls[2]); // same range re-sent, not skipped
});

test("persistent failure gives a clear error, not a hang", async () => {
  const { fetchImpl } = recorder(() => json({}, 502));
  await assert.rejects(uploadFileToCloudinary(blob(25 * 1024 * 1024), sig, fetchImpl), /interrupted/);
});

test("Cloudinary's own plan limit is surfaced explicitly (not silently blocked, not blamed on the app)", async () => {
  const { fetchImpl } = recorder(() =>
    json({ error: { message: "File size too large. Got 12582912. Maximum is 10485760." } }, 400));
  await assert.rejects(uploadFileToCloudinary(blob(12_582_912), sig, fetchImpl), (e: unknown) => {
    assert.ok(e instanceof CloudinaryUploadError);
    assert.equal(e.providerLimit, true);
    assert.match(e.message, /Maximum is 10485760/);
    assert.match(e.message, /Cloudinary plan/);
    return true;
  });
});

test("other Cloudinary errors keep Cloudinary's message; network failure is explained", async () => {
  await assert.rejects(
    uploadFileToCloudinary(blob(10), sig, recorder(() => json({ error: { message: "Invalid Signature" } }, 401)).fetchImpl),
    (e: unknown) => e instanceof CloudinaryUploadError && !e.providerLimit && /Invalid Signature/.test(e.message));
  await assert.rejects(uploadFileToCloudinary(blob(10), sig, async () => { throw new TypeError("x"); }), /Network error/);
});

test("a result outside the signed folder or in a disallowed format is rejected", async () => {
  await assert.rejects(
    uploadFileToCloudinary(blob(10), sig, recorder(() => json(okJson({ public_id: "someone-else/x" }))).fetchImpl),
    /unexpected location/);
  await assert.rejects(
    uploadFileToCloudinary(blob(10), sig, recorder(() => json(okJson({ format: "svg" }))).fetchImpl),
    /valid JPEG, PNG or WebP/);
});

test("no public_id is sent when the server didn't sign one (Cloudinary generates it, as before)", async () => {
  const { calls, fetchImpl } = recorder(() => json(okJson({ public_id: "giftpacific/banners/auto123" })));
  const { publicId: _omit, ...noId } = sig; void _omit;
  await uploadFileToCloudinary(blob(10), noId, fetchImpl);
  assert.ok(!calls[0].body.has("public_id"));
});
