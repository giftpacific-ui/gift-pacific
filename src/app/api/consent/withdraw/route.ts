import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { isValidConsentRef } from "@/lib/analytics/consent-ref";
import { RATE_LIMITS, clientAddress, consumeRateLimit } from "@/lib/rate-limit";
import { logServerError } from "@/lib/logger";
import { withdrawTrackingConsent } from "@/server/services/consent-withdrawal.service";

/**
 * POST { ref?: string } - the visitor withdrew tracking consent in the browser. Stops server-side Meta CAPI / GA4 events that have not
 * been delivered yet for (a) the browser's opaque consent reference and (b) the signed-in customer's own orders.
 *
 * Safe by construction: the only thing it can do is stop tracking (fail-closed), so a forged call can at worst withdraw the forger's own or a
 * guessed-128-bit reference's consent. It is same-origin only, rate limited, accepts a tiny body, and answers with nothing but { ok: true }
 * whether or not anything matched (no order ids, no counts, no enumeration).
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return NextResponse.json({ ok: false }, { status: 403 });
    } catch {
      return NextResponse.json({ ok: false }, { status: 403 });
    }
  }

  const throttle = await consumeRateLimit(RATE_LIMITS.consentWithdraw, [await clientAddress()]);
  if (!throttle.ok) return NextResponse.json({ ok: false }, { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } });

  let ref: string | null = null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });
    const body = text ? (JSON.parse(text) as { ref?: unknown }) : {};
    if (body.ref !== undefined && body.ref !== null) {
      if (!isValidConsentRef(body.ref)) return NextResponse.json({ ok: false }, { status: 400 });
      ref = body.ref;
    }
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    const session = await getSession(); // signed-in customer (guests have none): covers orders placed from other devices
    await withdrawTrackingConsent({ consentRef: ref, userId: session?.sub ?? null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logServerError("consent.withdraw", error);
    // 500 so the browser keeps its pending marker and retries on the next page load.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
