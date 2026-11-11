/**
 * URL allow-listing for admin-supplied URLs that end up in `href`/`src` on
 * the public site. Scheme allow-list (never a deny-list): anything that is
 * not http(s) — or, where explicitly allowed, a same-site relative path —
 * is rejected, which covers javascript:, data:, vbscript:, file:, blob: etc.
 */

/** Absolute http(s) URL only. */
export function isSafeHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Same-site relative path ("/shop"), but not protocol-relative ("//evil.com") or backslash tricks. */
export function isSafeRelativePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//") &&
    !trimmed.includes("\\") &&
    !/[\u0000-\u001f]/.test(trimmed)
  );
}

/**
 * Post-login `?redirect=` target. Only same-site paths are honoured — an
 * attacker-crafted link like /login?redirect=//evil.com or
 * ?redirect=https://evil.com must not send a freshly logged-in user off-site.
 */
export function safeRedirectPath(value: string | null | undefined, fallback: string): string {
  return value && isSafeRelativePath(value) ? value : fallback;
}

/** Link target: absolute http(s) or a safe relative path. Empty is allowed by callers separately. */
export function isSafeLinkTarget(value: string): boolean {
  return isSafeHttpUrl(value) || isSafeRelativePath(value);
}

/** Image source stored for products/variants: absolute https (or http) URL only. */
export function isSafeImageUrl(value: string): boolean {
  return isSafeHttpUrl(value);
}
