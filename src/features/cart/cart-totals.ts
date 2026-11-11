import { fromPaisa, toPaisa } from "@/lib/money";
import type { CartItemDTO } from "@/features/cart/cart.types";

/** One definition of "units" and "subtotal" for the header badge, drawer, cart page and checkout. Sums in whole paisa. */
export function getCartTotals(items: readonly Pick<CartItemDTO, "unitPrice" | "quantity">[]) {
  let paisa = 0;
  let units = 0;
  for (const item of items) {
    paisa += toPaisa(item.unitPrice) * item.quantity;
    units += item.quantity;
  }
  return { units, subtotal: fromPaisa(paisa) };
}
