/**
 * List-Unsubscribe headers (Prompt 11, RFC 2369 + RFC 8058 one-click). PURE: no database, no network, no secrets, no `node:crypto`.
 *
 * The ONLY extra e-mail headers this system will ever put on a message are the two below, and only with a value that passed `checkUnsubscribeUrlShape`.
 * Both the campaign worker (which builds them) and the SMTP layer (which refuses anything else) use these functions, so a header value that could
 * smuggle a line break, a second URL, a `mailto:` target or a non-HTTPS scheme cannot reach Nodemailer from any caller.
 */

export const LIST_UNSUBSCRIBE_HEADER = "List-Unsubscribe";
export const LIST_UNSUBSCRIBE_POST_HEADER = "List-Unsubscribe-Post";
/** RFC 8058 section 3.1: the exact value that tells the receiver the URL accepts a one-click POST. */
export const LIST_UNSUBSCRIBE_POST_VALUE = "List-Unsubscribe=One-Click";
export const MAX_UNSUBSCRIBE_URL_LENGTH = 2048;

export type ListUnsubscribeHeaders = { "List-Unsubscribe": string; "List-Unsubscribe-Post": string };

// Visible ASCII only (no space, CR, LF, tab, other control characters or non-ASCII), and none of the characters that end an angle-bracketed URI or an attribute.
const VISIBLE_ASCII = /^[\u0021-\u007e]+$/;
const FORBIDDEN = /[<>"'\\`]/;

export const isLoopbackHost = (hostname: string): boolean => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());

/**
 * Is `url` an acceptable unsubscribe URL in this environment? In PRODUCTION: https only and never a loopback host. Elsewhere (development, tests):
 * https, or http to a loopback host only, so local work does not need a certificate. The URL must be canonical (what `new URL()` would print), carry
 * no credentials, query or fragment, and contain nothing but visible ASCII. It does NOT check the path or that the host is ours: see unsubscribe.ts.
 */
export function checkUnsubscribeUrlShape(url: unknown, nodeEnv: string | undefined): { ok: true; url: URL } | { ok: false } {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_UNSUBSCRIBE_URL_LENGTH) return { ok: false };
  if (!VISIBLE_ASCII.test(url) || FORBIDDEN.test(url)) return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.href !== url) return { ok: false };
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return { ok: false };
  const production = nodeEnv === "production";
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol === "https:") return production && loopback ? { ok: false } : { ok: true, url: parsed };
  if (parsed.protocol === "http:" && !production && loopback) return { ok: true, url: parsed };
  return { ok: false };
}

/** The two headers for one validated unsubscribe URL: `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
export function buildListUnsubscribeHeaders(url: unknown, nodeEnv: string | undefined): { ok: true; headers: ListUnsubscribeHeaders } | { ok: false } {
  if (!checkUnsubscribeUrlShape(url, nodeEnv).ok) return { ok: false };
  return { ok: true, headers: { [LIST_UNSUBSCRIBE_HEADER]: `<${url as string}>`, [LIST_UNSUBSCRIBE_POST_HEADER]: LIST_UNSUBSCRIBE_POST_VALUE } };
}

/** Strict re-check used by the SMTP layer: exactly these two headers, nothing else, each with exactly the expected shape. */
export function isValidListUnsubscribeHeaders(headers: unknown, nodeEnv: string | undefined): headers is ListUnsubscribeHeaders {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return false;
  const keys = Object.keys(headers);
  if (keys.length !== 2 || !keys.includes(LIST_UNSUBSCRIBE_HEADER) || !keys.includes(LIST_UNSUBSCRIBE_POST_HEADER)) return false;
  const h = headers as Record<string, unknown>;
  if (h[LIST_UNSUBSCRIBE_POST_HEADER] !== LIST_UNSUBSCRIBE_POST_VALUE) return false;
  const value = h[LIST_UNSUBSCRIBE_HEADER];
  if (typeof value !== "string" || value.length < 3 || value[0] !== "<" || value[value.length - 1] !== ">") return false;
  return checkUnsubscribeUrlShape(value.slice(1, -1), nodeEnv).ok;
}

/**
 * RFC 8058 section 3.1: the POST body must carry `List-Unsubscribe=One-Click`, as `application/x-www-form-urlencoded` or `multipart/form-data`.
 * Anything else (an empty body, another value, the pair twice, a different content type) is NOT a one-click request, so a bot that merely POSTs to
 * the URL cannot unsubscribe anyone.
 */
export function isOneClickUnsubscribeBody(body: unknown, contentType?: string | null): boolean {
  if (typeof body !== "string" || body.length === 0 || body.length > 1024) return false;
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "multipart/form-data") {
    const parts = body.match(/name="List-Unsubscribe"\s*\r?\n\r?\n[^\r\n]*/gi) ?? [];
    return parts.length === 1 && /\r?\n\r?\n\s*One-Click\s*$/.test(parts[0]);
  }
  if (type !== "application/x-www-form-urlencoded") return false;
  try {
    const values = new URLSearchParams(body).getAll(LIST_UNSUBSCRIBE_HEADER);
    return values.length === 1 && values[0] === "One-Click";
  } catch {
    return false;
  }
}
