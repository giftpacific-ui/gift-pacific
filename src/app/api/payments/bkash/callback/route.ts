import { NextResponse } from "next/server";
import { clientAddress, consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { absoluteUrl } from "@/lib/seo";
import { logServerError } from "@/lib/logger";
import { handleBkashReturn } from "@/server/services/gateway-payment.service";

// The customer's browser comes back here from bKash with ?paymentID=…&status=success|failure|cancel.
// Nothing in the query string is trusted: the service asks bKash (server to server) what really happened, and only
// that answer can credit a payment. The redirect target is built from OUR record of the order, never from the URL.
export const dynamic = "force-dynamic";

const back = (path: string) => NextResponse.redirect(absoluteUrl(path), 303);

export async function GET(request: Request) {
  const throttle = await consumeRateLimit(RATE_LIMITS.paymentCallback, [await clientAddress()]);
  if (!throttle.ok) return new NextResponse("Too many requests", { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } });

  const url = new URL(request.url);
  const paymentId = url.searchParams.get("paymentID");
  if (!paymentId || paymentId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(paymentId)) return back("/account/orders");

  try {
    const result = await handleBkashReturn(paymentId, url.searchParams.get("status"));
    if (!result.orderNumber) return back("/account/orders");
    return back(`/account/orders/${result.orderNumber}?payment=${result.outcome}`);
  } catch (error) {
    logServerError("gateway.bkash.callback", error);
    return back("/account/orders");
  }
}
