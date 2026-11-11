import type { Metadata } from "next";
import Link from "next/link";
import { listCourierAttention } from "@/server/services/courier.service";
import { getCourierConfig } from "@/lib/courier/config";
import { CourierAttentionList } from "@/features/admin/courier-attention-list";

export const metadata: Metadata = { title: "Courier · Admin" };

export default async function CourierAttentionPage() {
  const rows = await listCourierAttention();
  const config = getCourierConfig(process.env);
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Courier: orders needing attention</h1>
        <p className="text-sm text-muted-foreground">
          {config.provider && config.apiKey && config.apiSecret
            ? `Courier API booking is switched on (${config.provider}). It has not been verified against the live provider unless you have completed a real test booking. Automatic booking after confirmation is ${process.env.COURIER_AUTO_BOOK === "true" ? "ENABLED" : "off"}; scheduled status polling ${process.env.CRON_SECRET ? "is configured" : "needs CRON_SECRET and an external scheduler"}.`
            : "Courier API booking is switched off (COURIER_PROVIDER / COURIER_API_KEY / COURIER_API_SECRET not all set) — manual courier entry is available on every order."}
        </p>
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/courier/bulk" className="rounded-md border border-border px-3 py-2 font-medium hover:border-foreground">Bulk courier booking</Link>
        <Link href="/admin/courier/cod" className="rounded-md border border-border px-3 py-2 font-medium hover:border-foreground">COD reconciliation</Link>
      </div>
      <CourierAttentionList
        rows={rows.map((r) => ({
          id: r.id, orderNumber: r.orderNumber, status: r.status, reason: r.reason, consignmentId: r.courierConsignmentId,
          lastStatus: r.courierLastStatus, lastEventAt: r.courierLastEventAt ? r.courierLastEventAt.toISOString() : null, lastError: r.courierLastError,
        }))}
      />
    </div>
  );
}
