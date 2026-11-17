"use client";

import { useEffect, useRef } from "react";
import { trackPurchase } from "@/lib/analytics/events";
import type { PurchaseInput } from "@/lib/analytics/payloads";

/**
 * Browser half of the Purchase event. The page renders this ONLY for an order that is already confirmed (see
 * lib/analytics/purchase-policy.ts); an order that is merely placed produces no Purchase. Fires once per order per browser: a ref
 * guards React re-renders / Strict Mode, and localStorage guards reloads and later revisits. Sends no customer data; the event id
 * is purchase_<orderNumber>, identical to the server's, so Meta de-duplicates the pair.
 */
export function TrackPurchase({ order }: { order: PurchaseInput }) {
  const { orderNumber } = order;
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
    trackPurchase(order);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderNumber]);

  return null;
}
