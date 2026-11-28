import { NextResponse } from "next/server";
import { processEmailQueue } from "@/server/services/email-queue.service";
import { verifyBearerSecret } from "@/lib/courier/status";
import { logServerError } from "@/lib/logger";

// PROTECTED, OPTIONAL operator route. Nothing in this project schedules or calls it (no vercel.json, no Vercel Cron); on Vercel Hobby the e-mail queue is sent by explicit admin clicks instead
// (see src/server/services/email-manual-run.service). Drains the e-mail queue (P7.3.3). Same contract as /api/tracking/retry and /api/courier/reconcile: called by an EXTERNAL scheduler with
// `Authorization: Bearer $CRON_SECRET`; no secret configured => disabled (401). Schedule it every 1-5 minutes. The response is counts only
// (no addresses, subjects or errors). Each run sends a bounded batch within the hourly/daily limits, so it always finishes well inside maxDuration.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET?.trim() || null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await processEmailQueue()) });
  } catch (error) {
    logServerError("email_queue.run", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
