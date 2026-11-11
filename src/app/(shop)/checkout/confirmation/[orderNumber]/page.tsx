import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getOrderForConfirmation } from "@/server/services/order.service";
import { OrderDetailView } from "@/features/orders/order-detail-view";
import { Button } from "@/components/ui/button";
import { readConfirmationToken } from "@/server/confirmation";
import { TrackPurchase } from "@/features/checkout/track-purchase";

export const metadata: Metadata = { title: "Order Confirmed", robots: { index: false, follow: false } };

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  // Guests prove ownership with an httpOnly cookie set at checkout; the URL
  // carries only the order number (no secret in history/Referer/analytics).
  const token = await readConfirmationToken(orderNumber);
  const order = await getOrderForConfirmation(orderNumber, token);
  if (!order) notFound();

  return (
    <div className="container-boutique pt-10 pb-8 sm:pt-16">
      <div className="mb-10 flex flex-col items-center gap-3 text-center">
        <CheckCircle2 className="size-12 text-success" />
        <h1 className="font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold">Thank you for your order!</h1>
        <p className="text-muted-foreground">
          Your order number is <span className="font-medium text-foreground">{order.orderNumber}</span> — please
          keep it for reference. If you have an account, you can follow this order from your account page.
        </p>
        <Button asChild variant="outline" className="mt-2">
          <Link href="/shop">Continue shopping</Link>
        </Button>
      </div>

      <TrackPurchase orderNumber={order.orderNumber} value={Number(order.total)} currency={order.currency} />

      <OrderDetailView
        order={order}
        // Guests have no account session, so the account-protected invoice
        // route would just redirect them to login — only offer it to a
        // logged-in owner of this order.
        invoiceHref={order.userId ? `/account/orders/${order.orderNumber}/invoice` : undefined}
      />
    </div>
  );
}
