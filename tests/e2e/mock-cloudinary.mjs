import http from "node:http";
import { createHash } from "node:crypto";
export const SECRET = "fake-secret-for-e2e-only";
// ---- server-side SDK mock (delete / admin API) on :3999 ----
export function startSdkMock() {
  const calls = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    calls.push({ method: req.method, url: decodeURIComponent(req.url), body: b.slice(0, 200) });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ deleted: {}, result: "ok" })); }); });
  return new Promise((r) => server.listen(3999, () => r({ server, calls })));
}
// ---- browser-side mock of https://api.cloudinary.com (puppeteer request interception) ----
export function installBrowserMock(page, opts) {
  // opts: { limitBytes: number|null, log: [] }
  page.on("request", async (req) => {
    const u = req.url(); if (!u.startsWith("https://api.cloudinary.com/")) return;
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-unique-upload-id,content-range,content-type", "access-control-allow-methods": "POST,OPTIONS" };
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors });
    const h = req.headers(); const len = Number(h["content-length"] || 0); const range = h["content-range"]; const uid = h["x-unique-upload-id"];
    let fields = {}; let bodyLen = len; const hasRange = !!range;
    if (!hasRange) { try { const body = (await req.fetchPostData()) || ""; bodyLen = body.length; for (const m of body.matchAll(/name="([a-z_]+)"\r\n\r\n([^\r\n]*)\r\n/g)) fields[m[1]] = m[2]; } catch {} }
    const small = !hasRange;
    const entry = { url: u.replace("https://api.cloudinary.com", ""), len: bodyLen, range, uid, fields, hasDataUrl: small && Object.values(fields).some((v) => String(v).startsWith("data:")), ctype: h["content-type"]?.split(";")[0] };
    opts.log.push(entry);
    const json = (status, body) => req.respond({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    let probed = 0; if (!hasRange && opts.page) { try { probed = await opts.page.evaluate(() => (window.__cld.at(-1) || {}).fileSize || 0); } catch {} }
    const sizeForLimit = hasRange ? Number(/\/(\d+)$/.exec(range)?.[1] || 0) : Math.max(bodyLen, probed);
    if (opts.limitBytes && sizeForLimit > opts.limitBytes) return json(400, { error: { message: `File size too large. Got ${sizeForLimit}. Maximum is ${opts.limitBytes}.` } });
    if (small) { // verify the signature exactly like Cloudinary: sha1(sorted k=v pairs of signed params + api_secret)
      const signed = Object.entries(fields).filter(([k]) => !["file", "api_key", "signature", "resource_type", "cloud_name"].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
      const expect = createHash("sha1").update(signed + SECRET).digest("hex");
      entry.signatureOk = expect === fields.signature; if (!entry.signatureOk) return json(401, { error: { message: "Invalid Signature" } });
    }
    let last = true, total = bodyLen; if (range) { const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range); last = Number(m[2]) + 1 === Number(m[3]); total = Number(m[3]); }
    if (!last) return json(200, { done: false });
    const f = opts.fieldsForUid?.[uid] ?? fields; const folder = f.folder || "giftpacific/banners"; const pid = f.public_id || "auto" + Math.random().toString(16).slice(2, 8);
    const fmt = opts.format || "png";
    return json(200, { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${folder}/${pid}.${fmt}`, public_id: `${folder}/${pid}`, format: fmt, bytes: total });
  });
}
