"use client";

import Image from "next/image";
import Link from "next/link";
import { Minus, Plus, X } from "lucide-react";
import type { CartItemDTO } from "@/features/cart/cart.types";
import { useRemoveCartItem, useUpdateCartItemQuantity } from "@/features/cart/use-cart";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/utils";
import { MAX_QUANTITY_PER_LINE } from "@/lib/stock";

export function CartLineItem({ item }: { item: CartItemDTO }) {
  const updateQuantity = useUpdateCartItemQuantity();
  const removeItem = useRemoveCartItem();
  const outOfStock = !item.inStock;
  const maxQuantity = item.maxQuantity ?? MAX_QUANTITY_PER_LINE;
  const overStock = !outOfStock && item.quantity > maxQuantity;
  const personalization = item.customization ? Object.entries(item.customization) : [];

  return (
    <div className="flex gap-4 border-b border-border pb-5 last:border-b-0">
      <Link
        href={`/products/${item.productSlug}`}
        className="relative h-24 w-[4.5rem] shrink-0 overflow-hidden rounded-[3px] bg-secondary"
        tabIndex={-1}
        aria-hidden
      >
        {item.image && <Image src={item.image} alt="" fill sizes="72px" className="object-cover product-image-tone" />}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <Link href={`/products/${item.productSlug}`} className="font-heading text-lg leading-snug font-semibold transition-colors hover:text-primary">
            {item.productName}
          </Link>
          <button
            type="button"
            onClick={() => removeItem.mutate(item.id)}
            aria-label={`Remove ${item.productName} from your cart`}
            className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-destructive"
          >
            <X className="size-4" />
          </button>
        </div>

        {item.variantName && <p className="text-xs text-muted-foreground">{item.variantName}</p>}
        {personalization.length > 0 && (
          <ul className="text-xs text-muted-foreground">
            {personalization.map(([key, value]) => (
              <li key={key} className="truncate">
                <span className="capitalize">{key.replace(/[_-]+/g, " ")}</span>: {value}
              </li>
            ))}
          </ul>
        )}
        {item.components && item.components.length > 0 && (
          <ul className="text-xs text-muted-foreground" aria-label="Combo contents">
            {item.components.map((c) => (
              <li key={`${c.slot ?? "slot"}-${c.name}-${c.variant ?? ""}`} className="truncate">
                {c.quantity}× {c.name}
                {c.variant ? ` — ${c.variant}` : ""}
              </li>
            ))}
          </ul>
        )}
        {outOfStock && <p className="text-xs font-medium text-destructive">{item.unavailableReason ?? "Out of stock"}</p>}
        {overStock && <p className="text-xs font-medium text-destructive">Only {maxQuantity} left — please lower the quantity</p>}

        <div className="mt-auto flex items-center justify-between pt-1">
          <div className="flex items-center rounded-[3px] border border-border">
            <button
              type="button"
              className="grid size-9 place-items-center transition-colors hover:bg-secondary disabled:opacity-40"
              disabled={item.quantity <= 1 || outOfStock}
              onClick={() => updateQuantity.mutate({ id: item.id, quantity: item.quantity - 1 })}
              aria-label={`Decrease quantity of ${item.productName}`}
            >
              <Minus className="size-3.5" />
            </button>
            <span className="min-w-7 text-center text-sm font-semibold" aria-live="polite">
              {item.quantity}
            </span>
            <button
              type="button"
              className="grid size-9 place-items-center transition-colors hover:bg-secondary disabled:opacity-40"
              disabled={item.quantity >= maxQuantity || outOfStock}
              onClick={() => updateQuantity.mutate({ id: item.id, quantity: item.quantity + 1 })}
              aria-label={`Increase quantity of ${item.productName}`}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <span className="font-semibold">{formatPrice(item.unitPrice * item.quantity)}</span>
        </div>
      </div>
    </div>
  );
}

export function CartLineItemStatic({ item }: { item: CartItemDTO }) {
  // Read-only variant, used on order confirmation / order-detail views.
  return (
    <div className="flex gap-4">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-[3px] bg-secondary">
        {item.image && (
          <Image src={item.image} alt={item.productName} fill className="object-cover" />
        )}
      </div>
      <div className="flex-1 text-sm">
        <p className="font-medium">{item.productName}</p>
        {item.variantName && <p className="text-muted-foreground">{item.variantName}</p>}
        <p className="text-muted-foreground">Qty {item.quantity}</p>
      </div>
      <Button variant="ghost" size="icon" className="pointer-events-none opacity-0">
        <X />
      </Button>
    </div>
  );
}
