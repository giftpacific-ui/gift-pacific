"use client";

/**
 * `eventId` lets Meta de-duplicate this browser event against the same
 * event sent server-side (Conversions API), so a purchase is counted once.
 */
export function firePixelEvent(eventName: string, params?: Record<string, unknown>, eventId?: string) {
  if (typeof window === "undefined" || typeof window.fbq !== "function") return;
  if (eventId) window.fbq("track", eventName, params, { eventID: eventId });
  else window.fbq("track", eventName, params);
}
