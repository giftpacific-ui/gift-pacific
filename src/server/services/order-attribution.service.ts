import "server-only";
import { cookies, headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { ATTRIBUTION_COOKIE, buildOrderAttributionRecord, clientIpFromHeaders } from "@/lib/analytics/attribution";
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
    const record = buildOrderAttributionRecord({
      consentState: consentSnapshotFor(consentMode, jar.get(CONSENT_COOKIE)?.value),
      attributionCookie: jar.get(ATTRIBUTION_COOKIE)?.value,
      fbcCookie: jar.get("_fbc")?.value,
      fbpCookie: jar.get("_fbp")?.value,
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
