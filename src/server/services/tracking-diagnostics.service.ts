import "server-only";
import { prisma } from "@/lib/db/prisma";
import { GA4_ID_PATTERN, GTM_ID_PATTERN, isValidPixelId, isValidTikTokId } from "@/lib/analytics/ids";
import { resolveApiVersion, resolveMetaConfig } from "@/lib/analytics/server-events";
import { resolveGa4Config } from "@/lib/analytics/ga4-mp";

type Env = Record<string, string | undefined>;

export type TrackingDiagnostics = {
  consentMode: "OFF" | "OPT_IN";
  meta: {
    pixelConfigured: boolean;
    pixelSource: "admin settings" | "environment" | null;
    /** The Pixel id is public (it is in the page source), so it may be shown in full. */
    pixelId: string | null;
    capiState: "ready" | "no_pixel" | "invalid_pixel" | "no_token";
    apiVersion: string;
    testEventCodeActive: boolean;
  };
  google: { configured: boolean; kind: "GA4" | "GTM" | null; source: "admin settings" | "environment" | null };
  /** GA4 Measurement Protocol (server-side purchase). The measurement id is public; the API secret is never exposed. */
  ga4Server: {
    state: "ready" | "no_measurement_id" | "invalid_measurement_id" | "no_secret";
    measurementId: string | null;
    /** GA4_MP_DEBUG: events are validated by Google but NOT recorded. */
    validationOnly: boolean;
  };
  tiktok: { configured: boolean };
  retryJobEnabled: boolean;
  /** Variable NAMES only, never values. */
  missingEnv: string[];
  warnings: string[];
  events: {
    windowDays: number;
    counts: { sent: number; pending: number; failed: number; skipped: number };
    lastSentAt: Date | null;
    /** Oldest event still waiting (PENDING): how long events have been sitting undelivered. */
    oldestPendingAt: Date | null;
    recent: { id: string; destination: string; orderNumber: string; eventName: string; status: string; skipReason: string | null; attempts: number; errorCode: string | null; errorMessage: string | null; updatedAt: Date; retryable: boolean }[];
  };
};

/** Pure: derives the configuration section from settings + env. Unit-tested; never returns a secret value. */
export function describeTrackingConfig(settings: { metaPixelId: string | null; gtmId: string | null; tiktokPixelId: string | null; consentMode: "OFF" | "OPT_IN" }, env: Env) {
  const metaCfg = resolveMetaConfig(settings.metaPixelId, env);
  const pixelRaw = (settings.metaPixelId || env.NEXT_PUBLIC_META_PIXEL_ID || "").trim();
  const pixelSource = settings.metaPixelId ? ("admin settings" as const) : env.NEXT_PUBLIC_META_PIXEL_ID?.trim() ? ("environment" as const) : null;
  const googleRaw = (settings.gtmId || env.NEXT_PUBLIC_GTM_ID || "").trim().toUpperCase();
  const googleKind = GA4_ID_PATTERN.test(googleRaw) ? ("GA4" as const) : GTM_ID_PATTERN.test(googleRaw) ? ("GTM" as const) : null;
  const retryJobEnabled = (env.CRON_SECRET?.trim().length ?? 0) >= 24;

  const missingEnv: string[] = [];
  const warnings: string[] = [];
  const pixelOk = isValidPixelId(pixelRaw);
  if (pixelOk && !env.META_CONVERSIONS_API_TOKEN?.trim()) missingEnv.push("META_CONVERSIONS_API_TOKEN");
  if (pixelOk && env.META_CONVERSIONS_API_TOKEN?.trim() && !retryJobEnabled) missingEnv.push("CRON_SECRET");
  if (pixelRaw && !pixelOk) warnings.push("The Meta Pixel ID is not a valid numeric id; neither the Pixel nor the Conversions API will run.");
  if (googleRaw && !googleKind) warnings.push("The Google ID is neither a GA4 measurement id (G-XXXX) nor a GTM container id (GTM-XXXX); it is ignored.");
  const ga4 = resolveGa4Config(settings.gtmId, env);
  const ga4Id = ga4.ok ? ga4.config.measurementId : null;
  if (googleKind === "GTM" && !env.GA4_MEASUREMENT_ID?.trim() && env.GA4_API_SECRET?.trim()) warnings.push("GA4_API_SECRET is set but the storefront uses a GTM container, so the GA4 measurement id for server events is unknown. Set GA4_MEASUREMENT_ID (G-XXXX).");
  if (googleKind && !env.GA4_API_SECRET?.trim()) warnings.push("GA4 server-side purchase is not configured (GA4_API_SECRET missing): GA4 receives a purchase only from the browser, and only when the customer views the confirmation page after the order was confirmed.");
  if (ga4.ok && ga4.config.debug) warnings.push("GA4_MP_DEBUG is on: server purchases are validated by Google but NOT recorded, and the browser keeps sending the GA4 purchase. Turn it off after checking.");
  if (ga4.ok && !retryJobEnabled) missingEnv.push("CRON_SECRET");
  if (env.META_CAPI_TEST_EVENT_CODE?.trim()) warnings.push("META_CAPI_TEST_EVENT_CODE is set: server events go to Test Events only and are not used for optimisation.");
  if (settings.consentMode === "OFF" && (pixelOk || googleKind)) warnings.push("Consent mode is OFF: trackers load without asking visitors. That is the existing default; switch to OPT_IN if your audience requires opt-in consent.");

  const uniqueMissing = [...new Set(missingEnv)];
  return {
    consentMode: settings.consentMode,
    meta: {
      pixelConfigured: pixelOk,
      pixelSource,
      pixelId: pixelOk ? pixelRaw : null,
      capiState: metaCfg.ok ? ("ready" as const) : metaCfg.reason,
      apiVersion: resolveApiVersion(env),
      testEventCodeActive: Boolean(env.META_CAPI_TEST_EVENT_CODE?.trim()),
    },
    ga4Server: {
      state: ga4.ok ? ("ready" as const) : ga4.reason,
      measurementId: ga4Id,
      validationOnly: ga4.ok && ga4.config.debug,
    },
    google: { configured: googleKind !== null, kind: googleKind, source: settings.gtmId ? ("admin settings" as const) : env.NEXT_PUBLIC_GTM_ID?.trim() ? ("environment" as const) : null },
    tiktok: { configured: isValidTikTokId((settings.tiktokPixelId ?? "").trim()) },
    retryJobEnabled,
    missingEnv: uniqueMissing,
    warnings,
  };
}

export async function getTrackingDiagnostics(opts: { env?: Env; now?: Date } = {}): Promise<TrackingDiagnostics> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const windowDays = 7;
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const s = await prisma.storeSettings.findFirst({ select: { metaPixelId: true, gtmId: true, tiktokPixelId: true, consentMode: true } });
  const config = describeTrackingConfig(
    { metaPixelId: s?.metaPixelId ?? null, gtmId: s?.gtmId ?? null, tiktokPixelId: s?.tiktokPixelId ?? null, consentMode: (s?.consentMode ?? "OFF") as "OFF" | "OPT_IN" },
    env,
  );

  const rows = await prisma.trackingEventLog.findMany({
    where: { createdAt: { gte: since } },
    select: { id: true, destination: true, orderNumber: true, eventName: true, status: true, skipReason: true, attempts: true, errorCode: true, errorMessage: true, updatedAt: true, sentAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const counts = { sent: 0, pending: 0, failed: 0, skipped: 0 };
  let lastSentAt: Date | null = null;
  let oldestPendingAt: Date | null = null;
  for (const r of rows) {
    if (r.status === "SENT") {
      counts.sent += 1;
      if (r.sentAt && (!lastSentAt || r.sentAt > lastSentAt)) lastSentAt = r.sentAt;
    } else if (r.status === "FAILED") counts.failed += 1;
    else if (r.status === "SKIPPED") counts.skipped += 1;
    else {
      counts.pending += 1;
      if (!oldestPendingAt || r.createdAt < oldestPendingAt) oldestPendingAt = r.createdAt;
    }
  }
  const recent = rows
    .filter((r) => r.status !== "SENT")
    .slice(0, 15)
    .map((r) => ({
      id: r.id,
      destination: r.destination,
      orderNumber: r.orderNumber,
      eventName: r.eventName,
      status: r.status,
      skipReason: r.skipReason,
      attempts: r.attempts,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      updatedAt: r.updatedAt,
      retryable: r.status === "FAILED" || (r.status === "SKIPPED" && r.skipReason === "not_configured"),
    }));
  const warnings = [...config.warnings];
  if (!config.retryJobEnabled && oldestPendingAt && now.getTime() - oldestPendingAt.getTime() > 15 * 60_000) {
    warnings.push("Server events are waiting and the retry job is disabled (CRON_SECRET), so only the immediate post-confirmation attempt runs. Enable the job so failed events are retried.");
  }
  return { ...config, warnings, events: { windowDays, counts, lastSentAt, oldestPendingAt, recent } };
}
