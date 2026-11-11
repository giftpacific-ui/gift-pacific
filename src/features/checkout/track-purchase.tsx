"use client";

import { useEffect, useRef } from "react";
import { trackPurchase } from "@/lib/analytics/events";

/**
 * Fires the Purchase event exactly once per order per browser: a ref guards
 * React re-renders / Strict Mode, and localStorage guards reloads and later
 * revisits of the confirmation page. Sends only order number, value and currency.
 */
export function TrackPurchase({ orderNumber, value, currency }: { orderNumber: string; value: number; currency: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const key = `giftpacific_purchase_tracked_${orderNumber}`;
    // Pre-rebrand key: honoured so an order already reported to analytics is never reported a second time. Allow-listed legacy reference.
    // branding-guard:allow (documented legacy compatibility, see HANDOFF_GIFTPACIFIC.md)
    const legacyKey = `ap_purchase_tracked_${orderNumber}`;
    try {
      if (localStorage.getItem(key) || localStorage.getItem(legacyKey)) return;
      localStorage.setItem(key, "1");
    } catch {
      // Storage unavailable: prefer a possible missed event over a duplicate on every reload.
      return;
    }
    trackPurchase(orderNumber, value, currency);
  }, [orderNumber, value, currency]);

  return null;
}
