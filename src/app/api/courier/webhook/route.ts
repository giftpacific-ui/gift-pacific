import { NextResponse } from "next/server";
import { handleCourierWebhook, MAX_WEBHOOK_BYTES } from "@/server/services/courier.service";
import { readBodyLimited } from "@/lib/bounded-body";
import { logServerError } from "@/lib/logger";

// Server-to-server endpoint for the courier's delivery-status notifications.
// Authenticated with a shared secret (COURIER_WEBHOOK_SECRET) checked in
// constant time; idempotent (replays are no-ops). It is intentionally NOT
// behind the user/admin session proxy.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // The 64 KB limit is enforced on UTF-8 bytes WHILE READING the stream, so an
  // oversized (or Content-Length-less) body is cut off instead of buffered.
  const body = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) {
    return NextResponse.json({ ok: false }, { status: body.reason === "too_large" ? 413 : 400 });
  }

  try {
    const result = await handleCourierWebhook({
      authorization: request.headers.get("authorization"),
      rawBody: body.text,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    logServerError("courier.webhook", error);
    // 500 lets the courier retry; processing is idempotent.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: false }, { status: 405 });
}
