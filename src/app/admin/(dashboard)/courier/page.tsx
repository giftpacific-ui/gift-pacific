import type { Metadata } from "next";
import Link from "next/link";
import { getCourierDiagnostics, getCourierProviderBoard, isShipmentFilter, listCourierAttention, listCourierShipments } from "@/server/services/courier.service";
import { CourierAttentionList } from "@/features/admin/courier-attention-list";
import { CourierDiagnostics } from "@/features/admin/courier-diagnostics";
import { CourierShipmentsTable } from "@/features/admin/courier-shipments-table";

export const metadata: Metadata = { title: "Courier · Admin" };

export default async function CourierAttentionPage({ searchParams }: { searchParams: Promise<{ filter?: string; page?: string }> }) {
  const sp = await searchParams;
  const filter = isShipmentFilter(sp.filter) ? sp.filter : null;
  const [rows, shipments, board] = await Promise.all([listCourierAttention(), listCourierShipments(filter ?? "booked", Number(sp.page) || 1), getCourierProviderBoard()]);
  const diagnostics = getCourierDiagnostics();
  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Courier: orders needing attention</h1>
        <p className="text-sm text-muted-foreground">
          Steadfast, Pathao and RedX are listed below with their real status. Only Steadfast has an API adapter; Pathao and RedX parcels are recorded by hand on the order.
          Automatic booking after confirmation is {diagnostics.autoBook ? "ENABLED" : "off"}; scheduled status polling {diagnostics.cronConfigured ? "is configured" : "needs CRON_SECRET and an external scheduler"}.
        </p>
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/courier/bulk" className="rounded-md border border-border px-3 py-2 font-medium hover:border-foreground">Bulk courier booking</Link>
        <Link href="/admin/courier/cod" className="rounded-md border border-border px-3 py-2 font-medium hover:border-foreground">COD reconciliation</Link>
      </div>
      <CourierDiagnostics
        providers={board.providers.map((p) => ({
          key: p.key, label: p.label, state: p.state, stateLabel: p.stateLabel, detail: p.detail, adapterAvailable: p.adapterAvailable, isDefault: p.isDefault,
          hasWebhookSecret: p.hasWebhookSecret, canTest: p.canTest, lastCheckedAt: p.lastCheckedAt, lastConnectedAt: p.lastConnectedAt,
        }))}
        defaultMessage={board.defaultChoice.message}
        cronConfigured={diagnostics.cronConfigured}
        autoBook={diagnostics.autoBook}
        invoiceLookup={diagnostics.invoiceLookup}
      />
      <CourierShipmentsTable filter={filter} rows={shipments.rows} counts={shipments.counts} total={shipments.total} page={shipments.page} pageCount={shipments.pageCount} />
      <h2 className="font-heading text-base">Needs attention</h2>
      <CourierAttentionList
        rows={rows.map((r) => ({
          id: r.id, orderNumber: r.orderNumber, status: r.status, reason: r.reason, consignmentId: r.courierConsignmentId,
          lastStatus: r.courierLastStatus, lastEventAt: r.courierLastEventAt ? r.courierLastEventAt.toISOString() : null, lastError: r.courierLastError,
        }))}
      />
    </div>
  );
}
