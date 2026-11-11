"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate, formatPrice } from "@/lib/utils";
import { siteConfig } from "@/config/site";
import type { OrderDetailData } from "@/server/services/order.service";
import Image from "next/image";

type StoreInfo = {
  storeName: string;
  storeEmail?: string | null;
  storePhone?: string | null;
  storeAddress?: string | null;
  logoUrl?: string | null;
};

export function InvoiceView({
  order,
  store,
}: {
  order: OrderDetailData;
  store: StoreInfo;
}) {
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

  const logoUrl = store?.logoUrl;

  const handlePrint = () => {
    window.print(); // Triggers print, CSS handles hiding everything except the printable area
  };

  return (
    <div className="space-y-6">
      {/* Top Action Bar (Hidden during print) */}
      <div className="flex items-center justify-between print:hidden bg-white border border-border/60 px-6 py-4 rounded-2xl shadow-xs">
        <div>
          <h1 className="font-heading text-lg font-bold text-foreground">
            Invoice Preview
          </h1>
          <p className="text-xs text-muted-foreground">
            Ready for printing or PDF download
          </p>
        </div>
        <Button
          type="button"
          onClick={handlePrint}
          className="rounded-full px-5 h-11 font-medium gap-2 shadow-xs"
        >
          <Printer className="size-4" /> Print / Download PDF
        </Button>
      </div>

      {/* Main Invoice Card Paper View with ID for targeted printing */}
      <div
        id="printable-invoice"
        className="rounded-3xl border border-border/60 bg-white p-8 sm:p-12 shadow-xs print:rounded-none print:border-0 print:p-0 print:shadow-none text-foreground space-y-8"
      >
        {/* Header Section */}
        <div className="flex flex-wrap items-start justify-between gap-6 border-b border-border/60 pb-8">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h2 className="font-heading text-2xl font-extrabold text-foreground tracking-tight">
                {logoUrl ? (
                  <div className="flex items-center gap-2 m-4">
                    <Image
                      src={logoUrl || siteConfig.logoUrl}
                      alt={store.storeName}
                      width={140}
                      height={50}
                      className="max-h-12 sm:max-h-16 w-auto object-contain"
                      priority
                    />
                  </div>
                ) : (
                  store.storeName || siteConfig.name
                )}
              </h2>
            </div>
            {store.storeAddress && (
              <p className="text-xs text-muted-foreground max-w-xs">
                {store.storeAddress}
              </p>
            )}
            {store.storeEmail && (
              <p className="text-xs text-muted-foreground">
                {store.storeEmail}
              </p>
            )}
            {store.storePhone && (
              <p className="text-xs text-muted-foreground">
                {store.storePhone}
              </p>
            )}
          </div>

          <div className="text-right space-y-1">
            <h1 className="font-heading text-3xl font-extrabold uppercase tracking-wider text-neutral-900">
              Invoice
            </h1>
            <div className="inline-block px-3 py-1 bg-secondary/80 rounded-full text-xs font-semibold text-secondary-foreground mt-1">
              {order.orderNumber}
            </div>
            <p className="text-xs text-muted-foreground pt-1">
              Date: {formatDate(order.createdAt)}
            </p>
          </div>
        </div>

        {/* Customer & Payment Info Grid */}
        <div className="grid gap-6 sm:grid-cols-2 bg-neutral-50/60 p-6 rounded-2xl border border-border/50">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Billed To
            </h3>
            <div className="text-sm space-y-0.5 text-foreground">
              <p className="font-bold">{shipping.fullName}</p>
              <p className="text-muted-foreground">
                {shipping.line1}
                {shipping.line2 ? `, ${shipping.line2}` : ""}
              </p>
              <p className="text-muted-foreground">
                {shipping.city}
                {shipping.state ? `, ${shipping.state}` : ""}{" "}
                {shipping.postalCode}
              </p>
              <p className="text-muted-foreground font-medium">
                {shipping.country}
              </p>
              <p className="text-xs text-neutral-500 pt-1">
                Phone: {shipping.phone}
              </p>
            </div>
          </div>

          <div className="sm:text-right">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Payment Details
            </h3>
            <div className="text-sm space-y-1 text-foreground">
              <p>
                <span className="text-muted-foreground">Method:</span>{" "}
                <span className="font-semibold">
                  {order.paymentMethod === "COD"
                    ? "Cash on Delivery"
                    : order.paymentMethod}
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">Payment Status:</span>{" "}
                <span className="font-semibold uppercase text-xs px-2.5 py-0.5 rounded-full bg-secondary inline-block ml-1">
                  {order.paymentStatus.replaceAll("_", " ")}
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">Order Status:</span>{" "}
                <span className="font-medium text-foreground">
                  {order.status.replaceAll("_", " ")}
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Items Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/80 text-left text-xs uppercase tracking-wider font-semibold text-muted-foreground">
                <th className="py-3.5 px-2">Item Description</th>
                <th className="py-3.5 px-2 text-right">Qty</th>
                <th className="py-3.5 px-2 text-right">Unit Price</th>
                <th className="py-3.5 px-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {order.items.map((item) => {
                // OrderDetailData items carry a productName/variantName
                // snapshot taken at order time — no `any` needed.
                return (
                  <tr key={item.id} className="text-foreground">
                    <td className="py-4 px-2">
                      <span className="font-semibold block">
                        {item.productName}
                      </span>
                      {item.variantName && (
                        <span className="text-xs text-muted-foreground">
                          {item.variantName}
                        </span>
                      )}
                      {item.components.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Includes:{" "}
                          {item.components
                            .map((c) => `${c.quantity}× ${c.productName}${c.variantName ? ` — ${c.variantName}` : ""}`)
                            .join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="py-4 px-2 text-right font-medium text-muted-foreground">
                      {item.quantity}
                    </td>
                    <td className="py-4 px-2 text-right text-muted-foreground">
                      {formatPrice(Number(item.unitPrice))}
                    </td>
                    <td className="py-4 px-2 text-right font-bold">
                      {formatPrice(Number(item.lineTotal))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Totals Section */}
        <div className="border-t border-border/60 pt-6 flex justify-end">
          <div className="w-full max-w-sm space-y-2.5 text-sm">
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
              <span>Shipping Fee</span>
              <span className="font-medium text-foreground">
                {formatPrice(Number(order.shippingTotal))}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Estimated Tax</span>
              <span className="font-medium text-foreground">
                {formatPrice(Number(order.taxTotal))}
              </span>
            </div>
            <div className="flex justify-between border-t border-border/80 pt-4 text-base font-bold text-foreground">
              <span>Total Due</span>
              <span className="text-primary text-xl">
                {formatPrice(Number(order.total))}
              </span>
            </div>
          </div>
        </div>

        {/* Footer Note */}
        <div className="border-t border-border/60 pt-8 text-center space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            Thank you for your business!
          </p>
          <p>
            If you have any questions regarding this invoice, please contact
            support at {store.storeEmail || siteConfig.name}.
          </p>
        </div>
      </div>
    </div>
  );
}
