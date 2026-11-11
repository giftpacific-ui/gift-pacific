/**
 * Reads a request body while enforcing a byte limit WHILE READING — the whole
 * body is never buffered first, and a missing or forged Content-Length can't
 * bypass it. The limit is on UTF-8 BYTES, not string length (a string of
 * 25,000 three-byte characters is 75 KB but only 25,000 "characters").
 */
export type BoundedBody = { ok: true; text: string; bytes: number } | { ok: false; reason: "too_large" | "unreadable" };

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function readBodyLimited(request: Pick<Request, "headers" | "body">, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };

  const stream = request.body;
  if (!stream) return { ok: true, text: "", bytes: 0 };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined); // stop the sender / stop reading
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(merged), bytes: total };
}
