/** Pure inventory status rules shared by the admin Inventory page, product list and dashboard. */
export type InventoryState = "untracked" | "in_stock" | "low_stock" | "out_of_stock" | "procurement_required" | "procurement_pending";

export type InventoryInput = {
  trackInventory: boolean;
  stock: number;
  lowStockThreshold: number;
  allowBackorder: boolean;
  procurementPending: number;
  procurementLimit: number | null;
};

/**
 * Available-to-sell is `stock`: units are taken from stock when an order is PLACED (that is the reservation),
 * so stock already excludes everything promised to open orders. `procurementPending` is a separate counter of
 * units owed to customers but not yet physically received — it is never added to stock.
 */
export function inventoryState(i: InventoryInput): InventoryState {
  if (!i.trackInventory) return "untracked";
  if (i.stock <= 0) {
    if (i.allowBackorder) {
      const full = i.procurementLimit !== null && i.procurementPending >= i.procurementLimit;
      return full ? "out_of_stock" : i.procurementPending > 0 ? "procurement_pending" : "procurement_required";
    }
    return "out_of_stock";
  }
  if (i.procurementPending > 0) return "procurement_pending";
  return i.stock <= i.lowStockThreshold ? "low_stock" : "in_stock";
}

export const INVENTORY_STATE_LABEL: Record<InventoryState, string> = {
  untracked: "Not tracked",
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  procurement_required: "Sourced on order",
  procurement_pending: "Awaiting sourcing",
};
