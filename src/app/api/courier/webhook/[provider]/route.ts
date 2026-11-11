import { NextResponse } from "next/server";
import { readBodyLimited } from "@/lib/bounded-body";
import { logServerError } from "@/lib/logger";
import { MAX_WEBHOOK_BYTES, handleCourierWebhook } from "@/server/services/courier.service";

// Provider-specific webhook: /api/courier/webhook/<provider> uses THAT provider's own secret and parser. The original
// /api/courier/webhook route is unchanged and keeps serving the default courier. An unknown or unconfigured provider
// answers 404, exactly like a missing endpoint.
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const body = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) return NextResponse.json({ ok: false }, { status: body.reason === "too_large" ? 413 : 400 });
  try {
    const result = await handleCourierWebhook({ authorization: request.headers.get("authorization"), rawBody: body.text, provider });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    logServerError("courier.webhook", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
