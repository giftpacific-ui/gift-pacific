"use client";

import type { ComponentProps } from "react";
import { ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCart } from "@/features/cart/use-cart";
import { useCartUiStore } from "@/features/cart/cart-ui-store";
import { getCartTotals } from "@/features/cart/cart-totals";
import { cn } from "@/lib/utils";

/** Total units in the cart (undefined until the cart has loaded). */
export function useCartCount(): number | undefined {
  const { data } = useCart();
  return data ? getCartTotals(data.items).units : undefined;
}

export function CartCountBadge({ className }: { className?: string }) {
  const count = useCartCount();
  if (!count) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -top-0.5 -right-0.5 grid min-w-[1.1rem] place-items-center rounded-full bg-primary px-1 text-[0.68rem] leading-[1.1rem] font-bold text-primary-foreground",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Opens the cart drawer; shows the live item count (database-backed cart). */
export function CartButton({ className, ...props }: ComponentProps<typeof Button>) {
  const open = useCartUiStore((s) => s.open);
  const count = useCartCount();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={open}
      aria-label={count ? `Open cart, ${count} item${count === 1 ? "" : "s"}` : "Open cart"}
      aria-haspopup="dialog"
      className={cn("relative", className)}
      {...props}
    >
      <ShoppingBag />
      <CartCountBadge />
    </Button>
  );
}
