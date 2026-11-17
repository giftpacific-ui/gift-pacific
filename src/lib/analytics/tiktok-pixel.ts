// Global typing for the TikTok pixel object. Events go through tracking-state.ts (consent gate), not from here.
declare global {
  interface Window {
    ttq?: { track: (event: string, params?: Record<string, unknown>) => void; page: () => void };
  }
}

export {};
