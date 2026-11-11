import Image from "next/image";
import { isSafeHttpUrl } from "@/lib/url-safety";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { OrderTrackingTimeline } from "@/features/orders/order-tracking-timeline";
import { formatDate, formatPrice } from "@/lib/utils";
import { orderStatusBadgeVariant, orderStatusLabel } from "@/lib/order-status";
import { describeOrderPayment } from "@/lib/order-payment-view";
import { canBuyAgain } from "@/lib/reorder-rules";
import { BuyAgainButton } from "@/features/orders/buy-again-button";
import { PayWithBkashButton } from "@/features/orders/pay-with-bkash-button";
import type { PayOption } from "@/server/services/gateway-payment.service";
import type { OrderDetailData } from "@/server/services/order.service";
import {
  Package,
  Truck,
  CreditCard,
  MapPin,
  ArrowUpRight,
  ReceiptText,
} from "lucide-react";

export function OrderDetailView({
  order,
  invoiceHref,
  allowBuyAgain = false,
  payOption,
  paymentNotice,
}: {
  /** Online advance payment offer for the signed-in owner (only present when bKash is configured and a payment is due). */
  payOption?: PayOption;
  paymentNotice?: "success" | "cancelled" | "failed" | "pending" | "review" | "unknown";
  order: OrderDetailData;
  invoiceHref?: string;
  /** Signed-in owner view only (the guest confirmation page never offers it). */
  allowBuyAgain?: boolean;
}) {
  const payment = describeOrderPayment(order);
  const reorder = allowBuyAgain && canBuyAgain(order.status);
  const shipping = order.shippingSnapshot as {
    fullName: string;
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode?: string;
    country: string;
    phone: string;
  };

  return (
    <div className="space-y-6">
      {/* Top Banner Header */}
      <div className="bg-white border border-border/60 p-6 sm:p-8 rounded-3xl shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Order Details
          </p>
          <h1 className="font-heading text-2xl font-bold text-foreground mt-1 flex items-center gap-3">
            {order.orderNumber}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Badge
            variant={orderStatusBadgeVariant[order.status] ?? "default"}
            className="rounded-full px-3.5 py-1 text-xs uppercase font-semibold tracking-wider"
          >
            {order.status.replaceAll("_", " ")}
          </Badge>
          {invoiceHref && <ButtonAsLink href={invoiceHref} />}
          {reorder && <BuyAgainButton orderNumber={order.orderNumber} label="Buy all again" />}
        </div>
      </div>

      {/* Main Grid for Products & Summary */}
      <div className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6">
        <h2 className="font-heading text-lg font-bold text-foreground flex items-center gap-2">
          <Package className="size-5 text-primary" /> Ordered Items (
          {order.items.length})
        </h2>

        <div className="divide-y divide-border/40">
          {order.items.map((item) => (
            <div
              key={item.id}
              className="py-4 first:pt-0 last:pb-0 flex items-center justify-between gap-4"
            >
              <div className="flex items-center gap-4 min-w-0">
                <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl bg-neutral-100 border border-border/50">
                  {(() => {
                    const imageUrl =
                      item.imageUrl ?? item.product?.images?.[0]?.url;
                    return imageUrl ? (
                      <Image
                        src={imageUrl}
                        alt={item.productName}
                        fill
                        className="object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                        IMG
                      </div>
                    );
                  })()}
                </div>
                <div className="min-w-0 space-y-0.5">
                  {item.product ? (
                    <Link
                      href={`/products/${item.product.slug}`}
                      className="font-semibold text-foreground hover:underline transition-colors line-clamp-1 block"
                    >
                      {item.productName}
                    </Link>
                  ) : (
                    <span className="font-semibold text-foreground line-clamp-1 block">
                      {item.productName}
                    </span>
                  )}
                  {item.variantName && (
                    <p className="text-xs text-muted-foreground">
                      {item.variantName}
                    </p>
                  )}
                  {item.components.length > 0 && (
                    <ul className="text-xs text-muted-foreground" aria-label="Combo contents">
                      {item.components.map((c, i) => (
                        <li key={`${c.productName}-${i}`}>
                          {c.quantity}× {c.productName}
                          {c.variantName ? ` — ${c.variantName}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-neutral-500 font-medium">
                    Qty: {item.quantity}
                  </p>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-bold text-foreground">{formatPrice(Number(item.lineTotal))}</p>
                {reorder && item.components.length === 0 && (
                  <BuyAgainButton orderNumber={order.orderNumber} orderItemId={item.id} label="Buy again" compact />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Pricing Subtotals */}
        <div className="space-y-2 border-t border-border/60 pt-6 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="font-medium text-foreground">
              {formatPrice(Number(order.subtotal))}
            </span>
          </div>
          {Number(order.discountTotal) > 0 && (
            <div className="flex justify-between text-emerald-600">
              <span>
                Discount{order.coupon ? ` (${order.coupon.code})` : ""}
              </span>
              <span>-{formatPrice(Number(order.discountTotal))}</span>
            </div>
          )}
          <div className="flex justify-between text-muted-foreground">
            <span>Delivery charge</span>
            <span className="font-medium text-foreground">
              {Number(order.shippingTotal) === 0 ? "Free" : formatPrice(Number(order.shippingTotal))}
            </span>
          </div>
          {Number(order.deliveryDiscount) > 0 && (
            <div className="flex justify-between text-emerald-600">
              <span>Delivery reward applied</span>
              <span>-{formatPrice(Number(order.deliveryDiscount))}</span>
            </div>
          )}
          <div className="flex justify-between text-muted-foreground">
            <span>Tax</span>
            <span className="font-medium text-foreground">
              {formatPrice(Number(order.taxTotal))}
            </span>
          </div>
          <div className="flex justify-between border-t border-border/60 pt-4 text-base font-bold text-foreground">
            <span>Total Amount</span>
            <span className="text-primary text-lg">
              {formatPrice(Number(order.total))}
            </span>
          </div>
        </div>
      </div>

      {/* Address and Payment Info Section */}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-3">
          <h3 className="text-sm font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
            <MapPin className="size-4 text-primary" /> Shipping Address
          </h3>
          <div className="text-sm text-muted-foreground space-y-0.5 bg-neutral-50/50 p-4 rounded-2xl border border-border/40">
            <p className="font-semibold text-foreground">{shipping.fullName}</p>
            <p>
              {shipping.line1}
              {shipping.line2 ? `, ${shipping.line2}` : ""}
            </p>
            <p>
              {shipping.city}
              {shipping.state ? `, ${shipping.state}` : ""}{" "}
              {shipping.postalCode}
            </p>
            <p className="font-medium text-foreground">{shipping.country}</p>
            <p className="pt-2 text-xs text-neutral-500">
              Phone: {shipping.phone}
            </p>
          </div>
        </div>

        <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-3">
          <h3 className="text-sm font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
            <CreditCard className="size-4 text-primary" /> Payment Info
          </h3>
          <div className="text-sm text-muted-foreground space-y-1.5 bg-neutral-50/50 p-4 rounded-2xl border border-border/40">
            <p className="flex justify-between">
              <span className="text-neutral-500">Method:</span>{" "}
              <span className="font-semibold text-foreground">
                {order.paymentMethod === "COD"
                  ? "Cash on Delivery"
                  : order.paymentMethod}
              </span>
            </p>
            <p className="flex justify-between">
              <span className="text-neutral-500">Status:</span>{" "}
              <span className="font-semibold text-foreground uppercase text-xs px-2 py-0.5 rounded-full bg-secondary">
                {order.paymentStatus.replaceAll("_", " ")}
              </span>
            </p>
            {paymentNotice && paymentNotice !== "unknown" && (
              <p role="status" className="rounded-md border border-border/60 bg-secondary/40 p-2 text-xs">
                {paymentNotice === "success" && "Your bKash payment was confirmed."}
                {paymentNotice === "cancelled" && "The bKash payment was cancelled. You have not been charged by us."}
                {paymentNotice === "failed" && "The bKash payment did not complete. You can try again."}
                {paymentNotice === "pending" && "We are still waiting for bKash to confirm your payment. This page will update once it does."}
                {paymentNotice === "review" && "bKash reported a payment that we need to check manually. We will contact you if anything is needed."}
              </p>
            )}
            {payOption?.available && (
              <div className="space-y-2 rounded-md border border-border/60 p-3">
                <p className="text-xs text-muted-foreground">An advance of {formatPrice(payOption.amount)} is due. Pay it now with bKash, or send it from your wallet and submit the reference.</p>
                <PayWithBkashButton orderNumber={order.orderNumber} amount={payOption.amount} />
              </div>
            )}
            {payment.advanceRequired > 0 && (
              <p className="flex justify-between">
                <span className="text-neutral-500">Advance required:</span>{" "}
                <span className="font-semibold text-foreground">{formatPrice(payment.advanceRequired)}</span>
              </p>
            )}
            {payment.advancePaid > 0 && (
              <p className="flex justify-between">
                <span className="text-neutral-500">Verified paid:</span>{" "}
                <span className="font-semibold text-emerald-700">{formatPrice(payment.advancePaid)}</span>
              </p>
            )}
            <p className="flex justify-between">
              <span className="text-neutral-500">{payment.closed ? "Amount due:" : "Remaining to pay:"}</span>{" "}
              <span className="font-semibold text-foreground">{formatPrice(payment.remainingDue)}</span>
            </p>
            {!payment.closed && payment.remainingDue > 0 && order.paymentMethod === "COD" && (
              <p className="text-xs text-muted-foreground">The remaining amount is paid in cash when the order is delivered.</p>
            )}
            {payment.rows.length > 0 && (
              <ul className="space-y-1 border-t border-border/40 pt-2 text-xs" aria-label="Payments">
                {payment.rows.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span>{p.label} · {p.method} · {formatDate(p.at)}</span>
                    <span className="font-medium">
                      {formatPrice(p.amount)}{" "}
                      <span className={p.state === "verified" ? "text-emerald-700" : p.state === "rejected" ? "text-destructive" : "text-muted-foreground"}>
                        {p.state === "verified" ? "Verified" : p.state === "awaiting" ? "Awaiting verification" : p.state === "rejected" ? "Not accepted" : "Refunded"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="flex justify-between pt-1">
              <span className="text-neutral-500">Placed on:</span>{" "}
              <span className="text-foreground">
                {formatDate(order.createdAt)}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Tracking Info Card */}
      <div className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-4">
        <h2 className="font-heading text-lg font-bold text-foreground flex items-center gap-2">
          <Truck className="size-5 text-primary" /> Tracking & Timeline
        </h2>
        {(order.courierName || order.trackingNumber) && (
          <div className="flex flex-wrap items-center gap-6 text-sm bg-neutral-50/60 p-4 rounded-2xl border border-border/50">
            {order.courierName && (
              <p>
                <span className="text-muted-foreground">Courier:</span>{" "}
                <span className="font-semibold text-foreground">
                  {order.courierName}
                </span>
              </p>
            )}
            {order.trackingNumber && (
              <p>
                <span className="text-muted-foreground">Tracking #:</span>{" "}
                <span className="font-semibold text-foreground">
                  {order.trackingNumber}
                </span>
              </p>
            )}
            {order.trackingUrl && isSafeHttpUrl(order.trackingUrl) && (
              <Link
                href={order.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-medium inline-flex items-center gap-1"
              >
                Track shipment <ArrowUpRight className="size-3.5" />
              </Link>
            )}
          </div>
        )}
        <div className="pt-2">
          <OrderTrackingTimeline
            currentStatus={order.status}
            events={order.trackingEvents}
          />
        </div>
        {order.trackingEvents.length > 0 && (
          <div className="border-t border-border/50 pt-4">
            <h3 className="mb-2 text-sm font-semibold">Status history</h3>
            <ol className="space-y-2 text-sm">
              {[...order.trackingEvents].reverse().map((event, index) => (
                <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span>
                    <span className="font-medium">{orderStatusLabel[event.status]}</span>
                    {event.note && <span className="text-muted-foreground"> — {event.note}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(event.createdAt)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {!order.courierName && !order.trackingNumber && ["SHIPPED", "OUT_FOR_DELIVERY"].includes(order.status) && (
          <p className="text-xs text-muted-foreground">Courier tracking details will appear here when the courier shares them.</p>
        )}
      </div>
    </div>
  );
}

function ButtonAsLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-secondary/80 text-secondary-foreground hover:bg-secondary font-medium text-xs transition-colors"
    >
      <ReceiptText className="size-3.5" /> View invoice
    </Link>
  );
}
