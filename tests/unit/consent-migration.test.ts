import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONSENT_KEY, readConsent } from "@/lib/analytics/consent";

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};
// branding-guard:allow (documented legacy compatibility, see HANDOFF_GIFTPACIFIC.md)
const LEGACY = "aura_consent_v1";

beforeEach(() => store.clear());

test("no stored choice → unknown", () => {
  assert.equal(readConsent(), "unknown");
});

test("current key is used", () => {
  store.set(CONSENT_KEY, "granted");
  assert.equal(readConsent(), "granted");
});

test("a pre-rebrand choice is honoured and copied to the new key; the legacy key is left in place", () => {
  store.set(LEGACY, "denied");
  assert.equal(readConsent(), "denied");
  assert.equal(store.get(CONSENT_KEY), "denied");
  assert.equal(store.get(LEGACY), "denied");
});

test("the new key wins over the legacy key; garbage values are ignored", () => {
  store.set(LEGACY, "granted");
  store.set(CONSENT_KEY, "denied");
  assert.equal(readConsent(), "denied");
  store.clear();
  store.set(CONSENT_KEY, "maybe");
  store.set(LEGACY, "nope");
  assert.equal(readConsent(), "unknown");
});
