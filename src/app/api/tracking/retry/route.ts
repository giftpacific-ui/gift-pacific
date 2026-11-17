import { NextResponse } from "next/server";
import { runTrackingMaintenance } from "@/server/services/tracking-event.service";
import { verifyBearerSecret } from "@/lib/courier/status";
import { logServerError } from "@/lib/logger";

// Retries / back-fills server-side ad-platform events (Meta Conversions API). Same contract as /api/courier/reconcile: called by an
// EXTERNAL scheduler with `Authorization: Bearer $CRON_SECRET`; no secret configured => disabled. The response is counts only.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET?.trim() || null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const summary = await runTrackingMaintenance();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    logServerError("tracking.retry", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
