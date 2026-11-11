"use client";

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

export function writeConsent(value: "granted" | "denied") {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Without storage the choice only lasts for this page view.
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
}
