"use client";

import { ATTRIBUTION_COOKIE } from "@/lib/analytics/attribution";
import { allCookieNames, deleteCookie, readCookie, writeCookie } from "@/lib/analytics/cookie";
import { CONSENT_COOKIE } from "@/lib/analytics/purchase-policy";
import { CONSENT_REF_COOKIE, CONSENT_REF_MAX_AGE_SECONDS, PENDING_WITHDRAWAL_KEY, generateConsentRef, isValidConsentRef } from "@/lib/analytics/consent-ref";

export type ConsentState = "unknown" | "granted" | "denied";
export const CONSENT_KEY = "giftpacific_consent_v1";
export const CONSENT_EVENT = "giftpacific:consent-changed";
/**
 * Storage key used before the Gift Pacific rebrand. Kept ONLY so a returning visitor's existing choice is honoured
 * (otherwise everyone would see the cookie banner again). It is read once and copied to CONSENT_KEY; it is never written.
 * This is an intentional, allow-listed legacy reference (see scripts/check-branding.mjs).
 */
// branding-guard:allow (documented legacy compatibility, see HANDOFF_GIFTPACIFIC.md)
const LEGACY_CONSENT_KEY = "aura_consent_v1";

const isChoice = (v: string | null): v is "granted" | "denied" => v === "granted" || v === "denied";

/** Reads the visitor's choice. localStorage can throw (private mode): treat that as "unknown". */
export function readConsent(): ConsentState {
  try {
    const current = window.localStorage.getItem(CONSENT_KEY);
    if (isChoice(current)) return current;
    const legacy = window.localStorage.getItem(LEGACY_CONSENT_KEY);
    if (isChoice(legacy)) {
      try {
        window.localStorage.setItem(CONSENT_KEY, legacy); // one-time copy; the legacy key is left untouched
      } catch {
        // Read-only storage: still honour the legacy choice for this page view.
      }
      return legacy;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Cookies set by the ad/analytics scripts (and our own attribution cookie) that must not outlive a withdrawn consent. */
const TRACKING_COOKIE_NAMES = new Set([ATTRIBUTION_COOKIE, CONSENT_REF_COOKIE, "_fbp", "_fbc", "_ga", "_gid", "_gat", "_gcl_au", "_ttp", "_tt_enable_cookie"]);
const TRACKING_COOKIE_PREFIXES = ["_ga_", "_gat_", "_gcl_", "_tt_", "ttcsid"];

/** Removes tracking cookies (best effort, across the host and its parent domains). Essential cookies are untouched. */
export function clearTrackingCookies() {
  for (const name of allCookieNames()) {
    if (TRACKING_COOKIE_NAMES.has(name) || TRACKING_COOKIE_PREFIXES.some((p) => name.startsWith(p))) deleteCookie(name);
  }
}

/**
 * The server cannot read localStorage, so the choice is mirrored into a first-party cookie. The checkout snapshots it onto the
 * order, which is how the server-side (Conversions API) event honours the visitor's decision after they have left the site.
 */
export function syncConsentCookie(state: ConsentState = readConsent()) {
  if (state === "unknown") return;
  if (readCookie(CONSENT_COOKIE) !== state) writeCookie(CONSENT_COOKIE, state, 60 * 60 * 24 * 365);
  if (state === "granted") ensureConsentRef();
}

/**
 * The opaque reference (see consent-ref.ts) minted while consent is granted. The checkout stores it on the order so that a later
 * withdrawal can find that order's undelivered server events. Random bytes only: it contains nothing about the person.
 */
export function ensureConsentRef(): string | undefined {
  const existing = readCookie(CONSENT_REF_COOKIE);
  if (isValidConsentRef(existing)) return existing;
  if (typeof crypto === "undefined" || !crypto.getRandomValues) return undefined; // no CSPRNG: no reference rather than a weak one
  const ref = generateConsentRef((b) => void crypto.getRandomValues(b as unknown as Parameters<typeof crypto.getRandomValues>[0]));
  writeCookie(CONSENT_REF_COOKIE, ref, CONSENT_REF_MAX_AGE_SECONDS);
  return ref;
}

type PendingWithdrawal = { ref: string | null; at: number };

/**
 * Tells the server that consent was withdrawn so it stops undelivered server-side events. The pending marker is written BEFORE the request
 * and cleared only on a successful answer, so a request lost to a page reload, going offline or a server error is retried
 * (flushPendingWithdrawal runs on every page load). The server operation is idempotent.
 */
export function requestWithdrawal(ref: string | null): void {
  try {
    window.localStorage.setItem(PENDING_WITHDRAWAL_KEY, JSON.stringify({ ref, at: Date.now() } satisfies PendingWithdrawal));
  } catch {
    // Without storage there is no retry across page loads, but the request below is still attempted.
  }
  void sendWithdrawal(ref);
}

async function sendWithdrawal(ref: string | null): Promise<void> {
  try {
    const res = await fetch("/api/consent/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ref ? { ref } : {}),
      credentials: "same-origin",
      keepalive: true, // survives the page reload that follows a withdrawal
    });
    if (res.ok) window.localStorage.removeItem(PENDING_WITHDRAWAL_KEY);
  } catch {
    // stays pending; retried on the next page load
  }
}

export function flushPendingWithdrawal(): void {
  try {
    const raw = window.localStorage.getItem(PENDING_WITHDRAWAL_KEY);
    if (!raw) return;
    const pending = JSON.parse(raw) as Partial<PendingWithdrawal>;
    void sendWithdrawal(isValidConsentRef(pending.ref) ? pending.ref : null);
  } catch {
    // unreadable marker: nothing to retry
  }
}

export function writeConsent(value: "granted" | "denied") {
  const previous = readConsent();
  const ref = readCookie(CONSENT_REF_COOKIE); // read BEFORE the cookies are cleared below
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Without storage the choice only lasts for this page view.
  }
  writeCookie(CONSENT_COOKIE, value, 60 * 60 * 24 * 365);
  if (value === "denied") {
    clearTrackingCookies(); // withdrawal: stop identifying this browser, not just stop sending
    // Only a WITHDRAWAL (granted -> denied) concerns the server: a first "decline" has nothing recorded to stop.
    if (previous === "granted") requestWithdrawal(isValidConsentRef(ref) ? ref : null);
  } else {
    ensureConsentRef();
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
}

/** useSyncExternalStore subscription shared by every consent-aware component. */
export function subscribeConsent(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
