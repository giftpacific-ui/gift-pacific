/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configureTracking, emitCommerceEvent, resetTrackingState } from "@/lib/analytics/tracking-state";
import { addToCartEvent, removeFromCartEvent } from "@/lib/analytics/payloads";

const item = { id: "p1", name: "Mug", price: 650, quantity: 2 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let w: any;
let fbqCalls: unknown[][];
let ttqCalls: unknown[][];
let gtagCalls: unknown[][];

beforeEach(() => {
  resetTrackingState();
  fbqCalls = []; ttqCalls = []; gtagCalls = [];
  w = { dataLayer: [], fbq: (...a: unknown[]) => fbqCalls.push(a), ttq: { track: (...a: unknown[]) => ttqCalls.push(a), page() {} }, gtag: (...a: unknown[]) => gtagCalls.push(a) };
  (globalThis as any).window = w;
});

test("BEFORE any consent decision nothing is sent; once tracking is NOT permitted, held events are dropped (never replayed later)", () => {
  emitCommerceEvent(addToCartEvent(item, "e1")); // arrives during hydration: queued, not sent
  assert.equal(fbqCalls.length + gtagCalls.length + w.dataLayer.length, 0);
  configureTracking({ permitted: false, ga4: null, meta: false, tiktok: false }); // banner shown / consent denied
  emitCommerceEvent(addToCartEvent(item, "e2"));
  configureTracking({ permitted: true, ga4: "gtag", meta: true, tiktok: false }); // user accepts later
  assert.equal(fbqCalls.length, 0, "events from before consent are NOT replayed");
  assert.equal(gtagCalls.length, 0);
  assert.equal(w.dataLayer.length, 0);
});

test("the hydration queue is flushed when tracking turns out to be permitted", () => {
  emitCommerceEvent(addToCartEvent(item, "first-view"));
  configureTracking({ permitted: true, ga4: "gtag", meta: true, tiktok: true });
  assert.equal(fbqCalls.length, 1);
  assert.equal(ttqCalls.length, 1);
  assert.equal(gtagCalls.length, 1);
});

test("Meta Pixel receives the event name, params and the shared eventID; custom events use trackCustom", () => {
  configureTracking({ permitted: true, ga4: null, meta: true, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "evt-123"));
  emitCommerceEvent(removeFromCartEvent(item, "evt-456"));
  assert.deepEqual(fbqCalls[0].slice(0, 2), ["track", "AddToCart"]);
  assert.deepEqual(fbqCalls[0][3], { eventID: "evt-123" });
  assert.equal((fbqCalls[0][2] as any).currency, "BDT");
  assert.deepEqual(fbqCalls[1].slice(0, 2), ["trackCustom", "RemoveFromCart"]);
  assert.deepEqual(fbqCalls[1][3], { eventID: "evt-456" });
});

test("GA4 direct (gtag.js): sends gtag('event', name, flat params) - NOT a plain dataLayer object, which gtag.js ignores", () => {
  configureTracking({ permitted: true, ga4: "gtag", meta: false, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "e"));
  assert.equal(gtagCalls.length, 1);
  assert.equal(gtagCalls[0][0], "event");
  assert.equal(gtagCalls[0][1], "add_to_cart");
  assert.equal((gtagCalls[0][2] as any).currency, "BDT");
  assert.equal((gtagCalls[0][2] as any).items[0].item_id, "p1");
  assert.equal(w.dataLayer.length, 0, "no plain-object push in gtag mode");
});

test("GA4 direct before gtag.js has loaded: a gtag stub queues the command on dataLayer in gtag's own (arguments) format", () => {
  delete w.gtag;
  configureTracking({ permitted: true, ga4: "gtag", meta: false, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "e"));
  assert.equal(typeof w.gtag, "function");
  assert.equal(w.dataLayer.length, 1);
  assert.equal(w.dataLayer[0][0], "event");
  assert.equal(w.dataLayer[0][1], "add_to_cart");
});

test("GTM: clears the previous ecommerce object, then pushes { event, event_id, ecommerce }; gtag is not called", () => {
  configureTracking({ permitted: true, ga4: "gtm", meta: false, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "e9"));
  assert.deepEqual(w.dataLayer[0], { ecommerce: null });
  assert.equal(w.dataLayer[1].event, "add_to_cart");
  assert.equal(w.dataLayer[1].event_id, "e9");
  assert.equal(w.dataLayer[1].ecommerce.value, 1300);
  assert.equal(gtagCalls.length, 0);
});

test("only configured destinations are called (a store without Meta sends nothing to fbq)", () => {
  configureTracking({ permitted: true, ga4: "gtm", meta: false, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "e"));
  assert.equal(fbqCalls.length, 0);
  assert.equal(ttqCalls.length, 0);
});

test("consent withdrawal: after permitted -> not permitted nothing more is sent, including a retry still waiting for the Pixel script", async () => {
  delete w.fbq; // Pixel script not loaded yet => the delivery waits and retries
  configureTracking({ permitted: true, ga4: null, meta: true, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "late"));
  configureTracking({ permitted: false, ga4: null, meta: false, tiktok: false }); // withdrawn
  w.fbq = (...a: unknown[]) => fbqCalls.push(a); // script finishes loading afterwards
  await sleep(400);
  assert.equal(fbqCalls.length, 0);
  emitCommerceEvent(addToCartEvent(item, "after"));
  assert.equal(fbqCalls.length, 0);
});

test("a Pixel that loads shortly after the event still receives it (once)", async () => {
  delete w.fbq;
  configureTracking({ permitted: true, ga4: null, meta: true, tiktok: false });
  emitCommerceEvent(addToCartEvent(item, "slow"));
  assert.equal(fbqCalls.length, 0);
  w.fbq = (...a: unknown[]) => fbqCalls.push(a);
  await sleep(400);
  assert.equal(fbqCalls.length, 1);
});

test("a throwing tracker can never break the caller", () => {
  w.fbq = () => { throw new Error("boom"); };
  configureTracking({ permitted: true, ga4: null, meta: true, tiktok: false });
  assert.doesNotThrow(() => emitCommerceEvent(addToCartEvent(item, "e")));
});
