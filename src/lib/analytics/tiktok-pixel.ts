"use client";

declare global {
  interface Window {
    ttq?: { track: (event: string, params?: Record<string, unknown>) => void; page: () => void };
  }
}

/**
 * Fires a TikTok Pixel event. A no-op unless the pixel actually loaded (no ID configured, not on
 * a trackable page, or the visitor has not consented) — so product code can call it freely.
 */
export function fireTikTokEvent(eventName: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined" || !window.ttq) return;
  try {
    window.ttq.track(eventName, params);
  } catch {
    // Analytics must never break the storefront.
  }
}
