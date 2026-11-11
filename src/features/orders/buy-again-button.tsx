"use client";

import { useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { buyAgainAction } from "@/server/actions/reorder.actions";
import { useInvalidateCart } from "@/features/cart/use-cart";
import { useCartUiStore } from "@/features/cart/cart-ui-store";

/** Adds past items to the cart at TODAY's price and availability, then opens the cart for review. It never places an order. */
export function BuyAgainButton({ orderNumber, orderItemId, label = "Buy again", compact = false }: { orderNumber: string; orderItemId?: string; label?: string; compact?: boolean }) {
  const [pending, startTransition] = useTransition();
  const invalidateCart = useInvalidateCart();
  const openCart = useCartUiStore((s) => s.open);

  return (
    <Button
      type="button"
      variant={compact ? "ghost" : "outline"}
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await buyAgainAction(orderNumber, orderItemId);
          if (!result.success) return void toast.error(result.message);
          await invalidateCart();
          result.skipped.forEach((s) => toast.warning(`${s.name}: ${s.reason}`));
          if (result.added > 0) {
            toast.success(result.added === 1 ? "Added to your cart at today's price" : `${result.added} items added to your cart at today's prices`);
            openCart();
          }
        })
      }
    >
      <RotateCcw className="size-3.5" aria-hidden /> {pending ? "Adding…" : label}
    </Button>
  );
}
