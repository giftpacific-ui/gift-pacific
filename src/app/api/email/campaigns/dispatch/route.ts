import { NextResponse } from "next/server";
import { dispatchDueCampaigns } from "@/server/services/email-campaign-scheduler.service";
import { verifyBearerSecret } from "@/lib/courier/status";
import { logServerError } from "@/lib/logger";

// PROTECTED, OPTIONAL operator route. Nothing in this project schedules or calls it; campaigns are started by the admin's Send now and continued by Continue sending. Starts SCHEDULED campaigns whose time has come, and resumes interrupted ones (Prompt 12). Same contract as /api/email/queue, /api/tracking/retry
// and /api/courier/reconcile: called by an EXTERNAL scheduler with `Authorization: Bearer $CRON_SECRET`; no secret configured => disabled (401).
// Schedule it every 1-5 minutes, together with /api/email/queue (which does the actual sending of what this queues). It QUEUES only; it sends nothing.
// The response is counts only: no campaign name, subject, body, address, link or error text. A bounded number of campaigns is handled per call and
// repeated or overlapping calls are safe (see email-campaign-scheduler.service).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET?.trim() || null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await dispatchDueCampaigns()) });
  } catch (error) {
    logServerError("email_campaign_scheduler.run", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
