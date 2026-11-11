/** schema.org ItemAvailability for a product, from its REAL stock policy (never "InStock" for goods that are not on hand). */
export type StockPolicyInput = {
  trackInventory: boolean;
  allowBackorder: boolean;
  type: string;
  stock: number;
  variants: readonly { stock: number; allowBackorder: boolean }[];
};

export type SchemaAvailability =
  | "https://schema.org/InStock"
  | "https://schema.org/BackOrder"
  | "https://schema.org/OutOfStock";

/**
 * - untracked, or at least one unit on hand → InStock
 * - nothing on hand but orders are accepted (procurement/backorder) and not full → BackOrder
 * - otherwise OutOfStock
 * `purchasable` is the storefront's own availability verdict (it already accounts for the procurement cap).
 */
export function schemaAvailability(policy: StockPolicyInput, purchasable: boolean): SchemaAvailability {
  if (!purchasable) return "https://schema.org/OutOfStock";
  if (!policy.trackInventory) return "https://schema.org/InStock";
  const onHand = policy.type === "VARIANT" ? policy.variants.some((v) => v.stock > 0) : policy.stock > 0;
  return onHand ? "https://schema.org/InStock" : "https://schema.org/BackOrder";
}
