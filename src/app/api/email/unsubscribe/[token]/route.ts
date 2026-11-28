import { readBodyLimited } from "@/lib/bounded-body";
import { isOneClickUnsubscribeBody } from "@/lib/email/list-unsubscribe";
import { badRequestPage, confirmPage, donePage, invalidPage, unavailablePage, UNSUBSCRIBE_RESPONSE_HEADERS } from "@/lib/email/unsubscribe-pages";
import { logServerWarning } from "@/lib/logger";
import { resolveUnsubscribeToken, unsubscribeByStableToken } from "@/server/services/email-unsubscribe.service";

/**
 * PUBLIC unsubscribe endpoint (Prompt 11): /api/email/unsubscribe/<token>. The token is the stable, HMAC-derived token of ONE contact (see
 * src/lib/email/unsubscribe.ts); the URL carries nothing else (no address, no id).
 *
 *   GET  (and HEAD)  validates the token and shows a confirmation page. It NEVER changes anything: mail scanners, link previewers and crawlers
 *                    that fetch the link cannot unsubscribe anyone.
 *   POST             the unsubscribe. It needs the RFC 8058 body `List-Unsubscribe=One-Click` (what mail clients send for one-click unsubscribe,
 *                    and what the confirmation page's button sends), so a bot that merely POSTs to the URL does nothing. It goes through the
 *                    P08 unsubscribe/suppression service (source LINK): closes the open marketing consent and creates/reactivates the UNSUBSCRIBED
 *                    suppression, never weakening a bounce, complaint or manual suppression. Repeating it is a no-op that answers the same.
 *
 * Privacy: every answer is a generic page. A valid, a repeated and an already-blocked address all get the same "You are unsubscribed"; every
 * malformed, forged, unknown or revoked token gets the same "not valid" page (404). No address, name or existence signal is ever returned, and
 * the token is never logged (this handler logs only a fixed code; instrumentation.ts also redacts this path from Next's own error log).
 * Not rate limited on purpose: a token is 256 unguessable bits, a lookup is one indexed read, and the large mail providers send one-click POSTs for
 * very many recipients from shared addresses that a per-IP limit would wrongly refuse. Cached by nobody (no-store).
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024;
type Ctx = { params: Promise<{ token: string }> };

const page = (status: number, html: string, extra: Record<string, string> = {}) => new Response(html, { status, headers: { ...UNSUBSCRIBE_RESPONSE_HEADERS, ...extra } });
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

async function tokenOf(ctx: Ctx): Promise<string | null> {
  try {
    const { token } = await ctx.params;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

export async function GET(_request: Request, ctx: Ctx) {
  try {
    const token = await tokenOf(ctx);
    const resolved = await resolveUnsubscribeToken(token); // read-only
    if (resolved.ok) return page(200, confirmPage(token as string));
    if (resolved.reason === "secret_unavailable") return page(503, unavailablePage(), { "Retry-After": "3600" });
    return page(404, invalidPage());
  } catch (error) {
    logServerWarning("email_unsubscribe.get_failed", `Unsubscribe page failed (${errName(error)})`);
    return page(500, unavailablePage());
  }
}

export async function POST(request: Request, ctx: Ctx) {
  try {
    const body = await readBodyLimited(request, MAX_BODY_BYTES);
    if (!body.ok) return page(body.reason === "too_large" ? 413 : 400, badRequestPage());
    if (!isOneClickUnsubscribeBody(body.text, request.headers.get("content-type"))) return page(400, badRequestPage());

    const result = await unsubscribeByStableToken(await tokenOf(ctx));
    if (result.ok) return page(200, donePage()); // same page for created / reactivated / upgraded / unchanged
    if (result.reason === "secret_unavailable") return page(503, unavailablePage(), { "Retry-After": "3600" });
    if (result.reason === "invalid_token" || result.reason === "unknown_token") return page(404, invalidPage());
    logServerWarning("email_unsubscribe.post_refused", `Unsubscribe was refused (${result.reason})`);
    return page(500, unavailablePage());
  } catch (error) {
    // Only the error CLASS is logged: never the token, the address or the message.
    logServerWarning("email_unsubscribe.post_failed", `Unsubscribe request failed (${errName(error)})`);
    return page(500, unavailablePage());
  }
}
