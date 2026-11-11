"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { useCartUiStore } from "@/features/cart/cart-ui-store";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useCart } from "@/features/cart/use-cart";
import { CartLineItem } from "@/features/cart/cart-line-item";
import { getCartTotals } from "@/features/cart/cart-totals";
import { formatPrice } from "@/lib/utils";

/**
 * `freeShippingThreshold` is the store's real setting (Admin → Settings), or
 * null when none is configured — in which case no progress bar is shown.
 */
export function CartDrawer({ freeShippingThreshold = null }: { freeShippingThreshold?: number | null }) {
  const isOpen = useCartUiStore((state) => state.isOpen);
  const close = useCartUiStore((state) => state.close);
  const { data: cart, isLoading } = useCart();

  const items = cart?.items ?? [];
  const { units, subtotal } = getCartTotals(items);

  const hasThreshold = freeShippingThreshold !== null && freeShippingThreshold > 0;
  const remaining = hasThreshold ? Math.max(freeShippingThreshold - subtotal, 0) : 0;
  const progress = hasThreshold ? Math.min(100, Math.round((subtotal / freeShippingThreshold) * 100)) : 0;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => (open ? undefined : close())}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 bg-background p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="font-heading text-2xl font-semibold">
            Your cart{units > 0 && <span className="ml-2 text-base font-normal text-muted-foreground">({units})</span>}
          </SheetTitle>
          <SheetDescription className="sr-only">Items in your shopping cart</SheetDescription>
        </SheetHeader>

        {items.length > 0 && hasThreshold && (
          <div className="border-b border-border px-5 py-3 text-sm">
            <p>
              {remaining > 0 ? (
                <>
                  Add <strong>{formatPrice(remaining)}</strong> more for free delivery.
                </>
              ) : (
                <strong className="text-success">You&apos;ve unlocked free delivery.</strong>
              )}
            </p>
            <div
              role="progressbar"
              aria-label="Progress to free delivery"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="mt-2 h-1 overflow-hidden rounded-full bg-secondary"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${remaining > 0 ? "bg-primary" : "bg-success"}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {isLoading && <p className="text-sm text-muted-foreground">Loading your cart</p>}
          {!isLoading && items.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-4 py-16 text-center">
              <Gift className="size-12 text-muted-foreground/50" aria-hidden />
              <div>
                <p className="font-heading text-xl font-semibold">Your cart is empty</p>
                <p className="mt-1 text-sm text-muted-foreground">Find something lovely to give — or keep.</p>
              </div>
              <Button asChild variant="outline" onClick={close}>
                <Link href="/shop">Browse the shop</Link>
              </Button>
            </div>
          )}
          {items.map((item) => (
            <CartLineItem key={item.id} item={item} />
          ))}
        </div>

        {items.length > 0 && (
          <SheetFooter className="gap-3 border-t border-border bg-card px-5 py-4">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-heading text-xl font-semibold">{formatPrice(subtotal)}</span>
            </div>
            <p className="text-xs text-muted-foreground">Delivery and discounts are calculated at checkout.</p>
            <Button asChild variant="ink" size="lg" onClick={close}>
              <Link href="/cart">View cart &amp; checkout</Link>
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
