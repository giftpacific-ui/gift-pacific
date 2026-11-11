"use server";

import { revalidatePath } from "next/cache";
import {
  addItemToCart,
  getCurrentCartDTO,
  removeCartItem as removeCartItemService,
  updateCartItemQuantity as updateCartItemQuantityService,
} from "@/server/services/cart.service";
import type { CartDTO } from "@/features/cart/cart.types";
import { toUserMessage } from "@/lib/errors";

export async function getCart(): Promise<CartDTO> {
  try {
    return await getCurrentCartDTO();
  } catch (error) {
    console.error("[getCart] returning empty cart after failure:", error);
    return { id: "", items: [] };
  }
}

export type AddToCartActionInput = {
  productId: string;
  variantId?: string | null;
  quantity: number;
  /** Untrusted — validated server-side against the product's personalization fields. */
    customization?: Record<string, string> | null;
  /** Untrusted — a customizable combo's choices; validated against its template on the server. */
  selections?: { slotId: string; optionId: string; quantity: number }[] | null;
};

export async function addToCart(
  input: AddToCartActionInput,
): Promise<
  { success: true; cart: CartDTO } | { success: false; message: string }
> {
  try {
    const cart = await addItemToCart({
      productId: input.productId,
      variantId: input.variantId ?? null,
      quantity: input.quantity,
            customization: input.customization ?? null,
      selections: input.selections ?? undefined,
    });
    revalidatePath("/cart");
    return { success: true, cart };
  } catch (error) {
    return {
      success: false,
      message: toUserMessage(error, "Could not add to cart."),
    };
  }
}

export async function updateCartItemQuantity(
  cartItemId: string,
  quantity: number,
): Promise<
  { success: true; cart: CartDTO } | { success: false; message: string }
> {
  try {
    const cart = await updateCartItemQuantityService(cartItemId, quantity);
    revalidatePath("/cart");
    return { success: true, cart };
  } catch (error) {
    return {
      success: false,
      message: toUserMessage(error, "Could not update cart."),
    };
  }
}

export async function removeCartItem(
  cartItemId: string,
): Promise<
  { success: true; cart: CartDTO } | { success: false; message: string }
> {
  try {
    const cart = await removeCartItemService(cartItemId);
    revalidatePath("/cart");
    return { success: true, cart };
  } catch (error) {
    return {
      success: false,
      message: toUserMessage(error, "Could not remove item."),
    };
  }
}
