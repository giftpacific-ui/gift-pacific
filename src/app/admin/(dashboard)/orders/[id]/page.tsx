import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminGetOrderById } from "@/server/services/order.service";
import { OrderDetailView } from "@/features/orders/order-detail-view";
import { AdminOrderControls } from "@/features/admin/admin-order-controls";
import { serializeDecimals } from "@/lib/serialize";
import { getCourierPanel } from "@/server/services/courier.service";
import { adminListOrderCostLines } from "@/server/services/external-order.service";
import { OrderCostsCard } from "@/features/admin/order-costs-card";
import { getSession } from "@/lib/auth/current-user";
import { getAdvancePanel } from "@/server/services/advance.service";
import { AdvancePanel } from "@/features/admin/advance-panel";
import { FraudPanel } from "@/features/admin/fraud-panel";
import { getOrderFraudPanel } from "@/server/services/fraud-review.service";
import { GoodsOutCard } from "@/features/admin/goods-out-card";
import { listGoodsStillOut } from "@/server/services/incident.service";
import { AdminCourierPanel } from "@/features/admin/admin-courier-panel";
import { OrderCourierIntelligence } from "@/features/admin/order-courier-intelligence";
import { getOrderCourierView } from "@/server/services/courier-intelligence-admin.service";

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
  const fraud = await getOrderFraudPanel(order.id, (await getSession())?.sub ?? null);
  // One assembly of the courier history and risk display data, reusing the fraud panel loaded above. Stored data only: opening the page calls no courier.
  const intelligence = await getOrderCourierView(order.id, { fraud });
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
          {intelligence && <OrderCourierIntelligence orderId={order.id} data={serializeDecimals(intelligence.panel)} history={intelligence.history} risk={intelligence.risk} />}
          {fraud && <FraudPanel data={fraud} />}
          {courier && <AdminCourierPanel orderId={order.id} data={courier} />}
                    <GoodsOutCard lines={goodsOut} />
          <AdminOrderControls order={serializeDecimals(order)} courierChoices={courier?.choices ?? []} staleBooking={courier?.staleBooking ?? false} />
          <OrderCostsCard orderId={order.id} lines={costLines} />
        </div>
      </div>
    </div>
  );
}
