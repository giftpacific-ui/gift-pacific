import type { OrderStatus } from "@prisma/client";

export const orderStatusBadgeVariant: Record<
  OrderStatus,
  "default" | "secondary" | "destructive" | "success"
> = {
  PENDING: "secondary",
  CONFIRMED: "default",
  PROCESSING: "default",
  SHIPPED: "default",
  OUT_FOR_DELIVERY: "default",
  DELIVERED: "success",
  CANCELLED: "destructive",
  FAILED_DELIVERY: "destructive",
  REFUND_REQUESTED: "secondary",
  REFUNDED: "secondary",
};

export const orderStatusLabel: Record<OrderStatus, string> = {
  PENDING: "Order Placed",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  FAILED_DELIVERY: "Delivery Failed",
  REFUND_REQUESTED: "Refund Requested",
  REFUNDED: "Refunded",
};
