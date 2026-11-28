import { NextResponse } from "next/server";
import { verifyBearerSecret } from "@/lib/courier/status";
import { logServerError } from "@/lib/logger";
import { runFraudMaintenance } from "@/server/services/fraud-risk.service";

// Retention + housekeeping for fraud data (erases IPs older than the configured retention, gives legacy orders their identity keys). Same contract as
// /api/courier/reconcile and /api/tracking/retry: called by an EXTERNAL scheduler with `Authorization: Bearer $CRON_SECRET`; no secret configured =>
// disabled. The response is counts only.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET?.trim() || null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runFraudMaintenance()) });
  } catch (error) {
    logServerError("fraud.maintenance", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
