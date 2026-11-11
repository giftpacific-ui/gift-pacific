import { create } from "zustand";

type SearchUiState = { isOpen: boolean; open: () => void; close: () => void };

/** UI-only state for the search overlay (like the cart drawer store). */
export const useSearchUiStore = create<SearchUiState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
