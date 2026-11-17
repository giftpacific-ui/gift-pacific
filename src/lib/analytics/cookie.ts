/** Tiny first-party cookie helpers (browser only; every function is a no-op on the server). */

export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const c = part.trim();
    if (c.startsWith(prefix)) return c.slice(prefix.length);
  }
  return undefined;
}

export function writeCookie(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax${secure}`;
}

/** Candidate Domain= values for a host: itself and every parent that still has two labels (shop.example.com -> example.com). */
export function cookieDomains(hostname: string): string[] {
  const labels = hostname.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

export function deleteCookie(name: string) {
  if (typeof document === "undefined") return;
  const base = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
  document.cookie = base;
  for (const d of cookieDomains(location.hostname)) {
    document.cookie = `${base}; Domain=${d}`;
    document.cookie = `${base}; Domain=.${d}`;
  }
}

export function allCookieNames(): string[] {
  if (typeof document === "undefined") return [];
  return document.cookie.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
}
