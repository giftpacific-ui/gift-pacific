import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ShopViewMode = "grid" | "list";

type ShopViewState = {
  mode: ShopViewMode;
  setMode: (mode: ShopViewMode) => void;
};

/**
 * Shared client-side store (not local useState) for the shop grid/list
 * toggle. The toggle button (ProductFilters) and the results grid
 * (ShopResultsGrid) are separate component instances — a plain `useState`
 * inside a custom hook gives each of them its own independent state, so
 * clicking the toggle updated only the button's own copy and the grid
 * never re-rendered. A Zustand store (matching the existing
 * `useCartUiStore` pattern) is the fix: one shared state, several
 * subscribers. `persist` keeps the localStorage-backed preference without
 * hand-rolling the read/write effects.
 */
const useShopViewStore = create<ShopViewState>()(
  persist(
    (set) => ({
      mode: "grid",
      setMode: (mode) => set({ mode }),
    }),
    { name: "shop-view-mode" },
  ),
);

export function useShopViewMode(): [ShopViewMode, (mode: ShopViewMode) => void] {
  const mode = useShopViewStore((state) => state.mode);
  const setMode = useShopViewStore((state) => state.setMode);
  return [mode, setMode];
}
