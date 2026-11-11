import type { OrderStatus } from "@prisma/client";

export type NotificationType = "ORDER" | "PAYMENT" | "REFUND" | "REVIEW" | "QUESTION";

/** Customer-facing wording for each order status change. Statuses not listed (e.g. PENDING) never notify. */
const ORDER_COPY: Partial<Record<OrderStatus, { title: string; body: string; type: NotificationType }>> = {
  CONFIRMED: { type: "ORDER", title: "Order confirmed", body: "We have confirmed your order and will start preparing it." },
  PROCESSING: { type: "ORDER", title: "Order is being prepared", body: "Your order is being packed." },
  SHIPPED: { type: "ORDER", title: "Order dispatched", body: "Your order is on its way." },
  OUT_FOR_DELIVERY: { type: "ORDER", title: "Out for delivery", body: "Your order is out for delivery today." },
  DELIVERED: { type: "ORDER", title: "Order delivered", body: "Your order was delivered. We would love to hear what you think." },
  CANCELLED: { type: "ORDER", title: "Order cancelled", body: "Your order was cancelled." },
  FAILED_DELIVERY: { type: "ORDER", title: "Delivery was not completed", body: "We could not complete the delivery. Open the order for details." },
  REFUND_REQUESTED: { type: "REFUND", title: "Refund request received", body: "We are reviewing your refund request." },
  REFUNDED: { type: "REFUND", title: "Refund completed", body: "Your order has been marked as refunded." },
};

export function orderStatusNotification(status: OrderStatus, orderNumber: string) {
  const copy = ORDER_COPY[status];
  if (!copy) return null;
  return {
    type: copy.type,
    title: copy.title,
    body: `${copy.body} (${orderNumber})`,
    href: `/account/orders/${orderNumber}`,
    // One notification per order per status: a status set again, or a retried request, cannot add a second one.
    dedupeKey: (orderId: string) => `order:${orderId}:${status}`,
  };
}
