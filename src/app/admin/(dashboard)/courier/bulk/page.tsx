import type { Metadata } from "next";
import { listBulkBookable, BULK_BOOKING_LIMIT } from "@/server/services/courier.service";
import { usableCourierProviders } from "@/lib/courier/registry";
import { BulkCourierBooking } from "@/features/admin/bulk-courier-booking";

export const metadata: Metadata = { title: "Bulk courier booking · Admin" };
export const dynamic = "force-dynamic";

export default async function BulkCourierPage() {
  const rows = await listBulkBookable();
  const usable = usableCourierProviders();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Bulk courier booking</h1>
        <p className="text-sm text-muted-foreground">
          Confirmed orders that have no courier booking yet. Every order is checked on its own (payment, review, stock and address rules), so one failure never stops the rest.
        </p>
      </div>
      <BulkCourierBooking
        ready={usable.length > 0}
        providers={usable.map((p) => ({ key: p.key, label: p.label }))}
        limit={BULK_BOOKING_LIMIT}
        rows={rows.map((r) => ({
          id: r.id, orderNumber: r.orderNumber, status: r.status, total: Number(r.total), paymentMethod: r.paymentMethod,
          courierBookingStatus: r.courierBookingStatus, lastError: r.courierLastError, createdAt: r.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
