import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminGetOrderById } from "@/server/services/order.service";
import { OrderDetailView } from "@/features/orders/order-detail-view";
import { AdminOrderControls } from "@/features/admin/admin-order-controls";
import { serializeDecimals } from "@/lib/serialize";
import { getCourierPanel } from "@/server/services/courier.service";
import { adminListOrderCostLines } from "@/server/services/external-order.service";
import { OrderCostsCard } from "@/features/admin/order-costs-card";
import { getAdvancePanel } from "@/server/services/advance.service";
import { AdvancePanel } from "@/features/admin/advance-panel";
import { GoodsOutCard } from "@/features/admin/goods-out-card";
import { listGoodsStillOut } from "@/server/services/incident.service";
import { AdminCourierPanel } from "@/features/admin/admin-courier-panel";

export const metadata: Metadata = { title: "Order Details · Admin Dashboard" };

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await adminGetOrderById(id);
  if (!order) notFound();
    const courier = await getCourierPanel(order.id);
  const costLines = await adminListOrderCostLines(order.id);
  const advance = await getAdvancePanel(order.id);
  const goodsOut = await listGoodsStillOut(order.id);

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-16">
      <div className="grid gap-8 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <OrderDetailView
            order={order}
            invoiceHref={`/admin/orders/${order.id}/invoice`}
          />
        </div>
        <div className="min-w-0 space-y-6">
          {advance && <AdvancePanel orderId={order.id} pending={order.status === "PENDING"} data={advance} />}
          {courier && <AdminCourierPanel orderId={order.id} data={courier} />}
                    <GoodsOutCard lines={goodsOut} />
          <AdminOrderControls order={serializeDecimals(order)} />
          <OrderCostsCard orderId={order.id} lines={costLines} />
        </div>
      </div>
    </div>
  );
}
