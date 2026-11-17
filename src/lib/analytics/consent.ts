"use client";

import { ATTRIBUTION_COOKIE } from "@/lib/analytics/attribution";
import { allCookieNames, deleteCookie, readCookie, writeCookie } from "@/lib/analytics/cookie";
import { CONSENT_COOKIE } from "@/lib/analytics/purchase-policy";

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
const TRACKING_COOKIE_NAMES = new Set([ATTRIBUTION_COOKIE, "_fbp", "_fbc", "_ga", "_gid", "_gat", "_gcl_au", "_ttp", "_tt_enable_cookie"]);
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
}

export function writeConsent(value: "granted" | "denied") {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Without storage the choice only lasts for this page view.
  }
  writeCookie(CONSENT_COOKIE, value, 60 * 60 * 24 * 365);
  if (value === "denied") clearTrackingCookies(); // withdrawal: stop identifying this browser, not just stop sending
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
