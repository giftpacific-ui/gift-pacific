"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  addToCart,
  getCart,
  removeCartItem,
  updateCartItemQuantity,
  type AddToCartActionInput,
} from "@/server/actions/cart.actions";

export const CART_QUERY_KEY = ["cart"] as const;

export function useCart() {
  return useQuery({
    queryKey: CART_QUERY_KEY,
    queryFn: () => getCart(),
    // Short staleTime: the cart is re-read when a page mounts after navigation instead of showing a minute-old copy.
    staleTime: 10_000,
  });
}

export function useAddToCart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddToCartActionInput) => addToCart(input),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.setQueryData(CART_QUERY_KEY, result.cart);
        toast.success("Added to your cart");
      } else {
        toast.error(result.message);
      }
    },
    onError: () => toast.error("Could not add to cart. Please try again."),
  });
}

export function useUpdateCartItemQuantity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, quantity }: { id: string; quantity: number }) =>
      updateCartItemQuantity(id, quantity),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.setQueryData(CART_QUERY_KEY, result.cart);
      } else {
        toast.error(result.message);
      }
    },
  });
}

export function useRemoveCartItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeCartItem(id),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.setQueryData(CART_QUERY_KEY, result.cart);
        toast.success("Removed from cart");
      } else {
        toast.error(result.message);
      }
    },
  });
}

/**
 * Call after the SERVER confirmed an order (the server already emptied the cart). Without this the
 * client cache (staleTime 60s) keeps showing the old cart until a full reload.
 */
export function useInvalidateCart() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CART_QUERY_KEY });
}
