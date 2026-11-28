import { NextResponse } from "next/server";
import { verifyBearerSecret } from "@/lib/courier/status";
import { cleanupIncompleteCheckouts } from "@/server/services/incomplete-checkout.service";
import { logServerError } from "@/lib/logger";

// Called by an EXTERNAL scheduler (same as /api/courier/reconcile) with `Authorization: Bearer $CRON_SECRET`. No secret configured => disabled (401).
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET?.trim() || null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await cleanupIncompleteCheckouts()) });
  } catch (error) {
    logServerError("checkout-recovery.cleanup", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
