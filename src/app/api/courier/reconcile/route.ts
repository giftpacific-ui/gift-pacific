import { NextResponse } from "next/server";
import { reconcileCourier } from "@/server/services/courier.service";
import { verifyBearerSecret } from "@/lib/courier/status";
import { logServerError } from "@/lib/logger";

// Called by an EXTERNAL scheduler (e.g. Vercel Cron, GitHub Actions, or `curl` from cron) with
// `Authorization: Bearer $CRON_SECRET`. No secret configured => the endpoint is disabled (404-style 401).
// Vercel Cron sends this header automatically when CRON_SECRET is set as a project env var.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET?.trim() || null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const summary = await reconcileCourier({ autoBook: process.env.COURIER_AUTO_BOOK === "true" });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    logServerError("courier.reconcile", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
