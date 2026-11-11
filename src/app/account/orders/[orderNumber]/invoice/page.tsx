import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOrderByNumberForCurrentUser } from "@/server/services/order.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { InvoiceView } from "@/features/orders/invoice-view";
import { serializeDecimals } from "@/lib/serialize";

export const metadata: Metadata = { title: "Invoice" };

export default async function AccountInvoicePage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  const [order, settings] = await Promise.all([
    getOrderByNumberForCurrentUser(orderNumber),
    getStoreSettings(),
  ]);
  if (!order) notFound();

  return <InvoiceView order={serializeDecimals(order)} store={serializeDecimals(settings)} />;
}
