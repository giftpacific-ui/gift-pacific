import "server-only";
import { cookies, headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { ATTRIBUTION_COOKIE, buildOrderAttributionRecord, clientIpFromHeaders, gaSessionCookieName } from "@/lib/analytics/attribution";
import { CONSENT_REF_COOKIE } from "@/lib/analytics/consent-ref";
import { resolveGa4Config } from "@/lib/analytics/ga4-mp";
import { CONSENT_COOKIE, consentSnapshotFor, type ConsentMode } from "@/lib/analytics/purchase-policy";

/**
 * Snapshots the visitor's attribution onto the order, once, right after it is placed.
 *
 * The values come from first-party cookies the browser set (gp_attr, _fbc, _fbp, gp_consent) and request headers. They are
 * client-controlled, so `buildOrderAttributionRecord` re-validates every field and, under OPT_IN without an explicit grant, keeps
 * only the consent state. Nothing here can change the order, and a failure is swallowed: the order already exists.
 */
export async function snapshotOrderAttribution(order: { id: string; userId: string | null; orderNumber: string }, consentMode: ConsentMode): Promise<void> {
  try {
    const jar = await cookies();
    const h = await headers();
    // The GA client/session id is read only when the server GA4 purchase can actually use it (data minimisation).
    const settings = await prisma.storeSettings.findFirst({ select: { gtmId: true } });
    const ga4 = resolveGa4Config(settings?.gtmId);
    const record = buildOrderAttributionRecord({
      consentState: consentSnapshotFor(consentMode, jar.get(CONSENT_COOKIE)?.value),
      attributionCookie: jar.get(ATTRIBUTION_COOKIE)?.value,
      fbcCookie: jar.get("_fbc")?.value,
      fbpCookie: jar.get("_fbp")?.value,
      gaCookie: ga4.ok ? jar.get("_ga")?.value : undefined,
      gaSessionCookie: ga4.ok ? jar.get(gaSessionCookieName(ga4.config.measurementId))?.value : undefined,
      consentRefCookie: jar.get(CONSENT_REF_COOKIE)?.value,
      ip: clientIpFromHeaders((n) => h.get(n)),
      userAgent: h.get("user-agent"),
    });
    await prisma.orderAttribution.createMany({
      data: [
        {
          orderId: order.id,
          userId: order.userId,
          firstTouch: (record.firstTouch ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          lastTouch: (record.lastTouch ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          fbc: record.fbc,
          fbp: record.fbp,
          clientIp: record.clientIp,
          clientUserAgent: record.clientUserAgent,
          gaClientId: record.gaClientId,
          gaSessionId: record.gaSessionId,
          consentRef: record.consentRef,
          consentState: record.consentState,
        },
      ],
      skipDuplicates: true, // one snapshot per order, never overwritten
    });
  } catch {
    // Attribution is best-effort. No customer data in this log line.
    console.error("[tracking] attribution snapshot failed", { orderNumber: order.orderNumber });
  }
}
