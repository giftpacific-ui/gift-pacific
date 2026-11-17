// Global typing for the GTM / gtag data layer. Events are NOT pushed from here any more: every event goes through
// tracking-state.ts, which applies the consent gate and picks the right GA4 delivery mode.
declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

export {};
