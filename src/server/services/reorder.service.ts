import "server-only";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { UserFacingError } from "@/lib/errors";
import { canBuyAgain } from "@/lib/reorder-rules";
import { addItemToCart } from "@/server/services/cart.service";

export type BuyAgainResult = { added: number; skipped: { name: string; reason: string }[] };

/**
 * Puts the lines of one of the customer's OWN past orders back into their cart. Nothing here creates an order:
 * every line goes through the normal add-to-cart path, so the CURRENT price, availability, variant and personalization
 * rules apply and stock is never bypassed. The old order's prices are never read. Delivery is recalculated by checkout.
 */
export async function buyAgain(orderNumber: string, orderItemId?: string): Promise<BuyAgainResult> {
  const session = await getSession();
  if (!session) throw new UserFacingError("Please sign in to reorder.");
  if (typeof orderNumber !== "string" || !orderNumber) throw new UserFacingError("Order not found.");

  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: session.sub }, // ownership is part of the query
    select: {
      status: true,
      items: { select: { id: true, productId: true, variantId: true, productName: true, quantity: true, customization: true, components: { select: { id: true }, take: 1 } } },
    },
  });
  if (!order) throw new UserFacingError("Order not found.");
  if (!canBuyAgain(order.status)) throw new UserFacingError("You can buy again once this order is delivered, cancelled or refunded.");

  const lines = orderItemId ? order.items.filter((i) => i.id === orderItemId) : order.items;
  if (lines.length === 0) throw new UserFacingError("That item is not part of this order.");

  const result: BuyAgainResult = { added: 0, skipped: [] };
  for (const line of lines) {
    if (line.components.length > 0) {
      result.skipped.push({ name: line.productName, reason: "Combos have to be built again from the product page." });
      continue;
    }
    try {
      await addItemToCart({ productId: line.productId, variantId: line.variantId, quantity: line.quantity, customization: line.customization ?? undefined });
      result.added += 1;
    } catch (error) {
      if (error instanceof UserFacingError) result.skipped.push({ name: line.productName, reason: error.message });
      else throw error;
    }
  }
  return result;
}
