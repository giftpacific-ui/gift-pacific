"use client";

import Link from "next/link";
import { useCart } from "@/features/cart/use-cart";
import { CartLineItem } from "@/features/cart/cart-line-item";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { getCartTotals } from "@/features/cart/cart-totals";
import { formatPrice } from "@/lib/utils";

export default function CartPage() {
  const { data: cart, isLoading } = useCart();
  const items = cart?.items ?? [];
  const { subtotal } = getCartTotals(items);
  const hasUnavailable = items.some((item) => !item.inStock);

  return (
    <div className="container-boutique pt-10 pb-8 sm:pt-16">
      <p className="eyebrow">Your selection</p>
      <h1 className="mb-8 font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold sm:mb-12">Your cart</h1>

      {isLoading ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading your cart">
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-4">
              <div className="h-24 w-[4.5rem] animate-pulse rounded-[3px] bg-secondary" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-5 w-1/2 animate-pulse rounded-sm bg-secondary" />
                <div className="h-4 w-1/4 animate-pulse rounded-sm bg-secondary" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Your cart is empty"
          description="Browse the shop to find something handmade and thoughtful."
          action={
            <Button asChild variant="ink">
              <Link href="/shop">Shop all products</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-10 lg:grid-cols-[1fr_22rem] lg:gap-16">
          <div className="space-y-5">
            {items.map((item) => (
              <CartLineItem key={item.id} item={item} />
            ))}
          </div>

          <aside aria-label="Order summary" className="h-fit space-y-4 rounded-[4px] border border-border bg-card p-6 lg:sticky lg:top-28">
            <h2 className="font-heading text-2xl font-semibold">Order summary</h2>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-semibold">{formatPrice(subtotal)}</span>
            </div>
            <p className="text-sm text-muted-foreground">Delivery charges and any coupon are calculated at checkout, where you&apos;ll see your final total.</p>
            {hasUnavailable && (
              <p role="alert" className="rounded-[3px] bg-destructive/10 p-3 text-sm text-destructive">
                Some items are unavailable — please remove them or lower the quantity to continue.
              </p>
            )}
            <Button asChild variant="ink" size="lg" className="h-13 w-full">
              <Link href="/checkout">Proceed to checkout</Link>
            </Button>
            <p className="text-center text-xs text-muted-foreground">Pay with cash on delivery.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
