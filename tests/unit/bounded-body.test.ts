import { test } from "node:test";
import assert from "node:assert/strict";
import { readBodyLimited, utf8ByteLength } from "@/lib/bounded-body";
import { formatServerError } from "@/lib/logger";

const enc = new TextEncoder();
function streamOf(chunks: Uint8Array[], onPull?: (i: number) => void) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(i);
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}
const req = (body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) => ({ headers: new Headers(headers), body });

test("byte length is UTF-8 bytes, not string length", () => {
  const text = "€".repeat(25_000); // 25,000 chars but 75,000 bytes
  assert.equal(text.length, 25_000);
  assert.equal(utf8ByteLength(text), 75_000);
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("বাংলা"), 15);
});

test("accepts bodies at/under the limit and decodes multi-byte text split across chunks", async () => {
  const bytes = enc.encode("বাংলা €"); // multi-byte, split mid-character below
  const r = await readBodyLimited(req(streamOf([bytes.slice(0, 4), bytes.slice(4)])), 1000);
  assert.deepEqual(r, { ok: true, text: "বাংলা €", bytes: bytes.length });
  assert.equal((await readBodyLimited(req(streamOf([new Uint8Array(100)])), 100)).ok, true); // exactly at the limit
  assert.deepEqual(await readBodyLimited(req(null), 10), { ok: true, text: "", bytes: 0 });
});

test("rejects oversize bodies by BYTES even when the character count is small", async () => {
  const body = enc.encode("€".repeat(25_000)); // 75,000 bytes, 25,000 chars
  const r = await readBodyLimited(req(streamOf([body])), 65_536);
  assert.deepEqual(r, { ok: false, reason: "too_large" });
});

test("the read is BOUNDED: it stops pulling once the limit is crossed (no full buffering)", async () => {
  let pulls = 0;
  const chunks = Array.from({ length: 1000 }, () => new Uint8Array(1024)); // 1 MB offered
  const r = await readBodyLimited(req(streamOf(chunks, () => pulls++)), 10 * 1024);
  assert.equal(r.ok, false);
  assert.ok(pulls < 30, `pulled ${pulls} chunks of 1000 — the stream was not cut off`);
});

test("a forged / missing Content-Length can't bypass the limit; an honest oversize one is refused before reading", async () => {
  const big = [new Uint8Array(5000)];
  assert.equal((await readBodyLimited(req(streamOf(big), { "content-length": "10" }), 1000)).ok, false); // lies low
  assert.equal((await readBodyLimited(req(streamOf(big)), 1000)).ok, false); // absent
  const stream = streamOf(big);
  const r = await readBodyLimited(req(stream, { "content-length": "999999" }), 1000);
  assert.equal(r.ok, false);
  assert.equal(stream.locked, false, "declared-too-large bodies must be rejected without opening a reader");
});

test("an erroring stream is reported as unreadable, not thrown", async () => {
  const bad = new ReadableStream({ pull() { throw new Error("socket reset"); } });
  assert.deepEqual(await readBodyLimited(req(bad as ReadableStream<Uint8Array>), 100), { ok: false, reason: "unreadable" });
});

test("server error log lines are structured, bounded and free of secrets/PII fields", () => {
  const err = Object.assign(new Error("Unique constraint failed\nTrace: " + "x".repeat(2000)), { code: "P2002" });
  const line = formatServerError("checkout.place-order", err, { orderNumber: "AP-1" });
  assert.equal(line.context, "checkout.place-order");
  assert.equal(line.code, "P2002");
  assert.ok(line.message.length <= 500 && !/[\n\r]/.test(line.message));
  assert.ok(line.stack.length <= 1500);
  assert.deepEqual(line.extra, { orderNumber: "AP-1" });
  assert.equal(formatServerError("x", "plain string").message, "plain string");
  assert.doesNotThrow(() => JSON.stringify(line));
});
