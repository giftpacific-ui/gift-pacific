import { create } from "zustand";

type CartUiState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

/**
 * This store only tracks whether the cart drawer is open — it is UI-only
 * state. The actual cart contents live in the database (or, for guests,
 * are resolved via a guest token) and are fetched with TanStack Query so
 * the cart stays correct across tabs/devices without duplicating server
 * state into the client store.
 */
export const useCartUiStore = create<CartUiState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
