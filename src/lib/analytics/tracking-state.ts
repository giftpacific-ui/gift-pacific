"use client";

import type { CommerceEvent } from "@/lib/analytics/payloads";

/**
 * The single gate every browser tracking event passes through.
 *
 *  - Nothing is sent until the root component has decided whether tracking is permitted (consent OFF, or opt-in granted).
 *  - When it is NOT permitted (opt-in without a grant, or consent withdrawn) every event is DROPPED, never held back: events that
 *    happen before consent must not be replayed after it. (This is the fix for `dataLayer` pushes that GTM would otherwise replay
 *    the moment it loads.)
 *  - A short in-memory queue (25 events / 5 s) only bridges the instant between page hydration and the scripts becoming ready, so the
 *    first ViewContent of a page is not lost.
 *
 * GA4 has two mutually exclusive modes (decided by the configured id): "gtag" (a G- measurement id, loaded via gtag.js) needs
 * `gtag('event', name, params)` calls - plain-object `dataLayer` pushes are ignored by gtag.js - while "gtm" (a GTM- container)
 * wants `dataLayer.push({ event, ecommerce })`.
 */

export type Ga4Mode = "gtag" | "gtm" | null;
export type TrackingConfig = { permitted: boolean; ga4: Ga4Mode; meta: boolean; tiktok: boolean };

const QUEUE_MAX = 25;
const QUEUE_TTL_MS = 5_000;
const RETRY_MS = 250;
const RETRY_LIMIT = 20;

let config: TrackingConfig | null = null; // null = undecided
let queue: { event: CommerceEvent; at: number }[] = [];

/** Called by the root component once consent + configured ids are known (and again whenever they change). */
export function configureTracking(next: TrackingConfig) {
  config = next;
  if (!next.permitted) {
    queue = [];
    return;
  }
  const pending = queue;
  queue = [];
  const now = Date.now();
  for (const q of pending) if (now - q.at <= QUEUE_TTL_MS) deliver(q.event, next, 0);
}

/** Test helper / HMR: forgets the decision and queued events. */
export function resetTrackingState() {
  config = null;
  queue = [];
}

export function emitCommerceEvent(event: CommerceEvent) {
  if (typeof window === "undefined") return;
  if (config === null) {
    queue.push({ event, at: Date.now() });
    if (queue.length > QUEUE_MAX) queue.shift();
    return;
  }
  if (!config.permitted) return; // dropped by design
  deliver(event, config, 0);
}

function ensureGtag() {
  window.dataLayer = window.dataLayer ?? [];
  if (typeof window.gtag !== "function") {
    // Same shape as Google's snippet: gtag.js only understands `arguments` objects pushed onto dataLayer.
    window.gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      (window.dataLayer as unknown[]).push(arguments);
    };
  }
}

/** Returns true when every configured destination accepted the event (false = a script is not ready yet). */
function deliverOnce(event: CommerceEvent, cfg: TrackingConfig, done: Set<string>): boolean {
  let allDone = true;
  try {
    if (event.ga4 && cfg.ga4 && !done.has("ga4")) {
      if (cfg.ga4 === "gtag") {
        ensureGtag();
        window.gtag!("event", event.ga4.name, event.ga4.params);
      } else {
        window.dataLayer = window.dataLayer ?? [];
        if (event.ga4.ecommerce) window.dataLayer.push({ ecommerce: null }); // clear the previous ecommerce object (Google's recommendation)
        window.dataLayer.push(
          event.ga4.ecommerce
            ? { event: event.ga4.name, event_id: event.eventId, ecommerce: event.ga4.params }
            : { event: event.ga4.name, event_id: event.eventId, ...event.ga4.params },
        );
      }
      done.add("ga4");
    }
    if (event.meta && cfg.meta && !done.has("meta")) {
      if (typeof window.fbq === "function") {
        window.fbq(event.meta.custom ? "trackCustom" : "track", event.meta.name, event.meta.params, { eventID: event.eventId });
        done.add("meta");
      } else allDone = false;
    }
    if (event.tiktok && cfg.tiktok && !done.has("tiktok")) {
      if (window.ttq) {
        window.ttq.track(event.tiktok.name, event.tiktok.params);
        done.add("tiktok");
      } else allDone = false;
    }
  } catch {
    // Analytics must never break the storefront.
  }
  return allDone;
}

function deliver(event: CommerceEvent, cfg: TrackingConfig, attempt: number, done: Set<string> = new Set()) {
  if (deliverOnce(event, cfg, done)) return;
  if (attempt >= RETRY_LIMIT) return;
  setTimeout(() => {
    // Re-check the live decision: consent may have been withdrawn while the script was still loading.
    if (config?.permitted) deliver(event, config, attempt + 1, done);
  }, RETRY_MS);
}
