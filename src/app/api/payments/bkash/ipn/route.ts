import { NextResponse } from "next/server";
import { readBodyLimited } from "@/lib/bounded-body";
import { logServerError } from "@/lib/logger";
import { clientAddress, consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { isTrustedSnsUrl, verifySnsSignature, type SnsEnvelope } from "@/lib/payments/sns";
import { handleBkashNotification } from "@/server/services/gateway-payment.service";

// bKash server-to-server notification (an SNS-signed message). It is only a NUDGE: after the signature and topic are
// verified it asks bKash itself about the payment it names; the message's own contents never credit anything.
// Enabled only when BKASH_IPN_TOPIC_ARN is set. Not behind the user/admin session proxy.
export const dynamic = "force-dynamic";
const MAX_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const topic = process.env.BKASH_IPN_TOPIC_ARN?.trim();
  if (!topic) return NextResponse.json({ ok: false }, { status: 404 });
  const throttle = await consumeRateLimit(RATE_LIMITS.paymentCallback, [await clientAddress()]);
  if (!throttle.ok) return NextResponse.json({ ok: false }, { status: 429 });

  const body = await readBodyLimited(request, MAX_BYTES);
  if (!body.ok) return NextResponse.json({ ok: false }, { status: body.reason === "too_large" ? 413 : 400 });

  let envelope: SnsEnvelope;
  try {
    const parsed = JSON.parse(body.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    envelope = parsed as SnsEnvelope;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  if (envelope.TopicArn !== topic || !(await verifySnsSignature(envelope))) return NextResponse.json({ ok: false }, { status: 403 });

  try {
    if (envelope.Type === "SubscriptionConfirmation") {
      const url = (envelope as { SubscribeURL?: unknown }).SubscribeURL;
      if (isTrustedSnsUrl(url)) await fetch(url, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
      return NextResponse.json({ ok: true });
    }
    if (envelope.Type === "Notification" && typeof envelope.Message === "string") {
      await handleBkashNotification(envelope.Message);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logServerError("gateway.bkash.ipn", error);
    return NextResponse.json({ ok: false }, { status: 500 }); // SNS retries; processing is idempotent
  }
}

export async function GET() {
  return NextResponse.json({ ok: false }, { status: 405 });
}
