import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOrderByNumberForCurrentUser } from "@/server/services/order.service";
import { OrderDetailView } from "@/features/orders/order-detail-view";
import { getBkashPayOption } from "@/server/services/gateway-payment.service";
import { RequestRefundDialog } from "@/features/orders/request-refund-dialog";

export const metadata: Metadata = { title: "Order Details" };

export default async function AccountOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNumber: string }>;
  searchParams: Promise<{ payment?: string }>;
}) {
  const { orderNumber } = await params;
  const { payment } = await searchParams;
  const order = await getOrderByNumberForCurrentUser(orderNumber);
  if (!order) notFound();
  const payOption = await getBkashPayOption(order.orderNumber);
  const notice = (["success", "cancelled", "failed", "pending", "review"] as const).find((n) => n === payment);

  return (
    <div className="space-y-4">
      <OrderDetailView order={order} invoiceHref={`/account/orders/${order.orderNumber}/invoice`} allowBuyAgain payOption={payOption} paymentNotice={notice} />
      {order.status === "DELIVERED" && <RequestRefundDialog orderNumber={order.orderNumber} />}
    </div>
  );
}
