// lib/fpixel.ts

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
  }
}

// Custom/Standard Event trigger function
export const event = (name: string, options = {}) => {
  if (typeof window !== "undefined" && window.fbq) {
    window.fbq("track", name, options);
  }
};
