/**
 * Stock / availability rules. Pure functions (no server-only imports) so the
 * exact same formula runs in client display code (cards, PDP, cart) and in
 * the server-side enforcement (cart + checkout) — one formula, not two that
 * can drift apart.
 *
 * ## Inventory model
 *  - STANDARD / PERSONALIZED products: stock lives on `Product.stock`.
 *  - VARIANT products: stock lives ONLY on `ProductVariant.stock`.
 *    `Product.stock` is meaningless for them and is never consulted.
 *    A VARIANT product with no purchasable variant is OUT OF STOCK.
 *  - BUNDLE products: the bundle has its OWN independent `Product.stock`
 *    (pre-assembled gift boxes — see the seed data and the admin form).
 *    Component stock is never consulted or consumed; the component list
 *    is descriptive ("this box includes…").
 *  - `trackInventory: false` means stock isn't counted at all (made to
 *    order): always purchasable, never decremented.
 */

export type StockFields = {
  stock: number;
  allowBackorder: boolean;
  trackInventory: boolean;
  /** Units already accepted beyond stock and still to be sourced. */
  procurementPending?: number;
  /** Max units allowed to be pending at once; null/undefined = no cap. */
  procurementLimit?: number | null;
};

/**
 * How many MORE units can be accepted beyond physical stock (Infinity = no cap). Stock itself never goes
 * negative: units beyond stock are tracked as procurement, up to the optional limit.
 */
export function backorderRoom(item: Pick<StockFields, "procurementPending" | "procurementLimit">): number {
  if (item.procurementLimit === null || item.procurementLimit === undefined) return Infinity;
  return Math.max(item.procurementLimit - (item.procurementPending ?? 0), 0);
}

/** Hard upper bound for a single cart line, independent of stock. */
export const MAX_QUANTITY_PER_LINE = 99;

export function isOutOfStock(item: StockFields): boolean {
  if (!item.trackInventory) return false;
  if (item.stock > 0) return false;
  if (item.allowBackorder) return backorderRoom(item) <= 0;
  return true;
}

/** The largest quantity that can currently be added/set for this item. */
export function maxOrderableQuantity(item: StockFields): number {
  if (!item.trackInventory) return Infinity;
  const onHand = Math.max(item.stock, 0);
  if (item.allowBackorder) return onHand + backorderRoom(item);
  return onHand;
}

/** True for a positive whole number within the per-line cap. */
export function isValidQuantity(quantity: unknown): quantity is number {
  return (
    typeof quantity === "number" &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_QUANTITY_PER_LINE
  );
}

// ---------------------------------------------------------------------------
// Availability (what the storefront shows)
// ---------------------------------------------------------------------------

export type ProductTypeName = "STANDARD" | "VARIANT" | "PERSONALIZED" | "BUNDLE";

export type VariantStockInput = { stock: number; allowBackorder: boolean; procurementPending?: number; procurementLimit?: number | null };

export type AvailabilityInput = {
  type: ProductTypeName;
  stock: number;
  allowBackorder: boolean;
  trackInventory: boolean;
  /** Required (may be empty) for VARIANT products. */
  variants?: readonly VariantStockInput[];
};

export type Availability = {
  inStock: boolean;
  /**
   * Largest quantity a customer can add in one line. `null` = unlimited
   * (untracked or backorder-enabled) — still capped by MAX_QUANTITY_PER_LINE
   * wherever it's used. For VARIANT products this is the best case over
   * purchasable variants and is informational only; the selected variant's
   * own availability governs the add-to-cart form.
   */
  maxQuantity: number | null;
};

export function getAvailability(item: StockFields): Availability {
  const max = maxOrderableQuantity(item);
  return {
    inStock: !isOutOfStock(item),
    maxQuantity: Number.isFinite(max) ? Math.min(max, MAX_QUANTITY_PER_LINE) : null,
  };
}

export function getVariantAvailability(
  variant: VariantStockInput,
  trackInventory: boolean,
): Availability {
  return getAvailability({
    stock: variant.stock,
    allowBackorder: variant.allowBackorder,
    procurementPending: variant.procurementPending,
    procurementLimit: variant.procurementLimit,
    trackInventory,
  });
}

export function getProductAvailability(input: AvailabilityInput): Availability {
  if (input.type !== "VARIANT") {
    return getAvailability(input);
  }

  // VARIANT: product-level stock is ignored on purpose.
  const purchasable = (input.variants ?? [])
    .map((v) => getVariantAvailability(v, input.trackInventory))
    .filter((a) => a.inStock);

  if (purchasable.length === 0) return { inStock: false, maxQuantity: 0 };
  if (purchasable.some((a) => a.maxQuantity === null)) {
    return { inStock: true, maxQuantity: null };
  }
  return {
    inStock: true,
    maxQuantity: Math.max(...purchasable.map((a) => a.maxQuantity ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Line resolution (server-authoritative: cart + checkout)
// ---------------------------------------------------------------------------

/**
 * Checks that a cart line's variant selection matches the product's type:
 * a VARIANT product requires one of ITS variants; every other type must not
 * carry a variant. Returns an error message, or null when valid.
 */
export function validateVariantSelection(args: {
  productType: ProductTypeName;
  variantId: string | null | undefined;
  variantBelongsToProduct: boolean;
}): string | null {
  const { productType, variantId, variantBelongsToProduct } = args;
  if (productType === "VARIANT") {
    if (!variantId) return "Please choose an option before adding this to your cart.";
    if (!variantBelongsToProduct) return "The selected option is not available.";
    return null;
  }
  if (variantId) return "The selected option is not available.";
  return null;
}

/** The stock fields that govern a cart/checkout line: the variant's for variant lines, else the product's. */
export function resolveLineStock(args: {
  trackInventory: boolean;
  product: VariantStockInput;
  variant: VariantStockInput | null;
}): StockFields {
  const source = args.variant ?? args.product;
  return {
    stock: source.stock,
    allowBackorder: source.allowBackorder,
    procurementPending: source.procurementPending,
    procurementLimit: source.procurementLimit,
    trackInventory: args.trackInventory,
  };
}

/** Total quantity already in the cart for one product/variant across ALL its lines (personalized lines are separate lines). */
export function totalQuantityFor(
  lines: readonly { productId: string; variantId: string | null; quantity: number }[],
  productId: string,
  variantId: string | null,
): number {
  return lines
    .filter((l) => l.productId === productId && (l.variantId ?? null) === (variantId ?? null))
    .reduce((sum, l) => sum + l.quantity, 0);
}
