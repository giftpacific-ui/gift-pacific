/**
 * The few pages the public unsubscribe endpoint can answer with (Prompt 11). PURE strings: no script, no external resource (so nothing can leak the
 * token through a Referer or a request), no e-mail address, no account details and no wording that differs between "no such contact" and "bad token":
 * the same generic text covers every kind of invalid link. The only dynamic value is the token inside the form action, and it is escaped (it already
 * had to match ^[A-Za-z0-9_-]{43}$ to get here).
 */
import { UNSUBSCRIBE_ROUTE_PREFIX } from "@/lib/email/unsubscribe-path";
import { LIST_UNSUBSCRIBE_HEADER } from "@/lib/email/list-unsubscribe";

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Headers every response of the endpoint carries: never cached, never indexed, never shows a Referer, scripts/frames/other origins blocked. */
export const UNSUBSCRIBE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">` +
  `<title>${escapeAttr(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f7f7f8;color:#1c1c1e}` +
  `main{max-width:28rem;margin:12vh auto;padding:2rem;background:#fff;border-radius:.75rem;box-shadow:0 1px 4px rgba(0,0,0,.08)}` +
  `h1{font-size:1.25rem;margin:0 0 .75rem}p{line-height:1.5;margin:.5rem 0}button{margin-top:1rem;padding:.65rem 1.25rem;font-size:1rem;border:0;border-radius:.5rem;background:#1c1c1e;color:#fff;cursor:pointer}</style>` +
  `</head><body><main>${body}</main></body></html>`;

/** GET with a valid link: asks for confirmation. Changes nothing by itself: the button sends a POST (the RFC 8058 body, so one handler serves both). */
export function confirmPage(token: string): string {
  return shell(
    "Unsubscribe",
    `<h1>Unsubscribe from marketing e-mails?</h1><p>Press the button to stop receiving marketing e-mails from us. Order and account e-mails are not affected.</p>` +
      `<form method="post" action="${escapeAttr(UNSUBSCRIBE_ROUTE_PREFIX + token)}"><input type="hidden" name="${LIST_UNSUBSCRIBE_HEADER}" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
  );
}

/** POST succeeded (including repeats and addresses that were already blocked): the same words every time. */
export const donePage = () => shell("Unsubscribed", `<h1>You are unsubscribed</h1><p>You will no longer receive marketing e-mails from us. This can take a short while to take effect for e-mails that are already on their way.</p>`);

/** Malformed, forged, unknown or revoked link: one generic page, never saying which. */
export const invalidPage = () => shell("Link not valid", `<h1>This link is not valid</h1><p>The unsubscribe link is incorrect or has expired. If you still receive e-mails you do not want, use the unsubscribe link in the most recent one.</p>`);

/** The request was not a proper unsubscribe request (missing or wrong body). */
export const badRequestPage = () => shell("Request not valid", `<h1>We could not process this request</h1><p>Please use the unsubscribe link from your e-mail.</p>`);

/** The server cannot verify links right now (configuration), or failed unexpectedly. Generic, and says nothing about any person. */
export const unavailablePage = () => shell("Try again later", `<h1>Please try again later</h1><p>We could not process your request right now. Your link stays valid: please try it again later.</p>`);
