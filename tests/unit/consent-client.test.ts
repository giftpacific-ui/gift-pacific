/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PENDING_WITHDRAWAL_KEY, isValidConsentRef } from "@/lib/analytics/consent-ref";
import { ensureConsentRef, flushPendingWithdrawal, readConsent, syncConsentCookie, writeConsent } from "@/lib/analytics/consent";

// A minimal browser: cookie jar, localStorage and a recording fetch.
const jar = new Map<string, string>();
const store = new Map<string, string>();
let requests: { url: string; init: any }[];
let answer: () => Promise<{ ok: boolean }>;
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jar.clear(); store.clear(); requests = []; answer = async () => ({ ok: true });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
      set cookie(raw: string) {
        const [pair, ...attrs] = raw.split(";");
        const i = pair.indexOf("=");
        const name = pair.slice(0, i).trim();
        const maxAge = attrs.map((a) => a.trim()).find((a) => a.startsWith("Max-Age="));
        if (maxAge && Number(maxAge.slice(8)) <= 0) jar.delete(name); else jar.set(name, pair.slice(i + 1));
      },
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "https:", hostname: "shop.test", host: "shop.test" } });
  (globalThis as any).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    dispatchEvent: () => true, addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  (globalThis as any).fetch = async (url: string, init: any) => { requests.push({ url, init }); return answer(); };
});

const pending = () => store.get(PENDING_WITHDRAWAL_KEY);

test("granting consent mints ONE opaque reference (random, URL-safe, no personal data) and mirrors the choice to a cookie", () => {
  writeConsent("granted");
  assert.equal(jar.get("gp_consent"), "granted");
  const ref = jar.get("gp_cref")!;
  assert.match(ref, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(isValidConsentRef(ref) && !ref.includes("@"));
  writeConsent("granted");
  syncConsentCookie("granted");
  assert.equal(jar.get("gp_cref"), ref, "stable while consent stays granted");
  jar.delete("gp_cref");
  assert.ok(ensureConsentRef() && jar.get("gp_cref") !== ref, "a missing one (consent granted before this feature) is minted on the next sync");
});

test("WITHDRAWAL: tracking cookies and the reference are cleared locally and the server is told, with the reference, before it is gone", async () => {
  writeConsent("granted");
  const ref = jar.get("gp_cref")!;
  for (const [k, v] of Object.entries({ _fbp: "fb.1.1.1", _fbc: "fb.1.1.abc", _ga: "GA1.1.1.1", _ga_ABCD1234: "GS1.1.1", gp_attr: "x", essential_session: "keep" })) jar.set(k, v);

  writeConsent("denied");
  assert.equal(jar.get("gp_consent"), "denied");
  for (const k of ["gp_cref", "_fbp", "_fbc", "_ga", "_ga_ABCD1234", "gp_attr"]) assert.ok(!jar.has(k), `${k} cleared`);
  assert.equal(jar.get("essential_session"), "keep", "essential cookies are untouched");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/consent/withdraw");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.keepalive, true);
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[0].init.body), { ref });
  assert.ok(pending(), "marker is set BEFORE the answer so a lost request is retried");
  await tick();
  assert.equal(pending(), undefined, "cleared once the server acknowledged");
});

test("a lost or rejected withdrawal stays pending and is retried on the next page load until the server acknowledges it", async () => {
  writeConsent("granted");
  const ref = jar.get("gp_cref")!;
  answer = async () => ({ ok: false }); // server error
  writeConsent("denied");
  await tick();
  assert.ok(pending());

  (globalThis as any).fetch = async () => { throw new TypeError("offline"); };
  flushPendingWithdrawal(); await tick();
  assert.ok(pending(), "still pending while offline");

  requests = []; answer = async () => ({ ok: true });
  (globalThis as any).fetch = async (url: string, init: any) => { requests.push({ url, init }); return answer(); };
  flushPendingWithdrawal(); await tick();
  assert.deepEqual(JSON.parse(requests[0].init.body), { ref });
  assert.equal(pending(), undefined);
  flushPendingWithdrawal(); await tick();
  assert.equal(requests.length, 1, "nothing left to send");
});

test("a first-time decline (never granted) has nothing recorded to stop, so no server request is made", async () => {
  assert.equal(readConsent(), "unknown");
  writeConsent("denied");
  await tick();
  assert.equal(requests.length, 0);
  assert.equal(pending(), undefined);
});

test("withdrawal without a reference (consent granted before this feature) still notifies the server, which then withdraws by the signed-in account", async () => {
  store.set("giftpacific_consent_v1", "granted");
  writeConsent("denied");
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), {});
});

test("a corrupt pending marker is ignored without throwing", () => {
  store.set(PENDING_WITHDRAWAL_KEY, "{not json");
  assert.doesNotThrow(() => flushPendingWithdrawal());
  store.set(PENDING_WITHDRAWAL_KEY, JSON.stringify({ ref: "<script>", at: 1 }));
  flushPendingWithdrawal();
  assert.deepEqual(JSON.parse(requests.at(-1)!.init.body), {}, "an invalid reference is never forwarded");
});
