"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  mergeAttribution,
  parseAttributionCookie,
  serializeAttributionCookie,
  touchFromLocation,
} from "@/lib/analytics/attribution";
import { readCookie, writeCookie } from "@/lib/analytics/cookie";
import { flushPendingWithdrawal, readConsent, subscribeConsent, syncConsentCookie, type ConsentState } from "@/lib/analytics/consent";

/**
 * Captures first-touch / last-touch attribution into a first-party cookie (gp_attr) on an eligible landing; the checkout copies it
 * onto the order after re-validating it on the server (src/server/services/order-attribution.service.ts).
 *
 * Consent: with consentMode OFF it always runs (the store does not ask - the documented default); with OPT_IN it runs only after an
 * explicit "granted". It also mirrors the visitor's choice into a cookie so the server can honour it. Renders nothing.
 */
export function AttributionCapture({ consentMode }: { consentMode: "OFF" | "OPT_IN" }) {
  const pathname = usePathname();
  const consent = useSyncExternalStore<ConsentState | "loading">(subscribeConsent, readConsent, () => "loading");
  const allowed = consentMode === "OFF" || consent === "granted";

  useEffect(() => {
    if (consent === "loading") return;
    syncConsentCookie(consent);
    flushPendingWithdrawal(); // a withdrawal the server has not acknowledged yet (offline, reload, error) is retried here
    if (!allowed) return;
    try {
      const touch = touchFromLocation({ pathname, search: window.location.search, referrer: document.referrer, ownHost: window.location.host });
      const existing = parseAttributionCookie(readCookie(ATTRIBUTION_COOKIE));
      const { cookie, changed } = mergeAttribution(existing, touch);
      if (changed && cookie) writeCookie(ATTRIBUTION_COOKIE, serializeAttributionCookie(cookie), ATTRIBUTION_MAX_AGE_SECONDS);
    } catch {
      // Attribution is best effort and must never affect the page.
    }
  }, [pathname, allowed, consent]);

  return null;
}
