/**
 * Combo products: pure rules (no database, no framework) shared by the cart, checkout
 * and admin so a combo's contents, price and stock demand are decided in ONE place.
 *
 * A combo is either
 *   FIXED         — a predefined list of components (ProductBundleItem), or
 *   CUSTOMIZABLE  — the customer picks components for each of the template's slots.
 *
 * Stock policy (which inventory moves when a combo is bought — NEVER both):
 *   OWN_STOCK   — the combo itself is a counted finished good (today's gift boxes);
 *                 its components are descriptive only.
 *   COMPONENTS  — each component's stock is consumed (a customizable combo always uses this).
 *
 * Price rule (decided here, never by the client):
 *   FIXED_PRICE    — the combo's own price + the surcharge of each chosen option.
 *   COMPONENT_SUM  — the sum of the CURRENT price of every component, option surcharges ignored.
 */
export type ComboMode = "FIXED" | "CUSTOMIZABLE";
export type ComboPricing = "FIXED_PRICE" | "COMPONENT_SUM";
export type ComboStockPolicy = "OWN_STOCK" | "COMPONENTS";

export const MAX_COMBO_SELECTIONS = 50;
export const MAX_COMPONENT_QTY = 99;

export type ComboVariant = { id: string; name: string; price: number; stock: number; allowBackorder: boolean };

export type ComboProduct = {
  id: string;
  name: string;
  /** "VARIANT" products need a variant to be chosen. */
  type: string;
  kind: string;
  status: string;
  price: number;
  costPrice: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  stock: number;
  variants: ComboVariant[];
};

export type ComboTemplate = {
  id: string;
  mode: ComboMode;
  pricing: ComboPricing;
  stockPolicy: ComboStockPolicy;
  /** The combo product's own price. */
  basePrice: number;
  fixedComponents: { productId: string; variantId: string | null; quantity: number; product: ComboProduct }[];
  slots: {
        id: string;
    label: string;
    helpText?: string | null;
    minSelect: number;
    maxSelect: number;
    maxPerOption: number;
    options: { id: string; productId: string; variantId: string | null; priceDelta: number; product: ComboProduct }[];
  }[];
};

export type SelectionInput = { slotId: string; optionId: string; quantity: number };

export type ResolvedComponent = {
  slotId: string | null;
  slotLabel: string | null;
  optionId: string | null;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  /** Units of this component in ONE combo. */
  quantity: number;
  unitPrice: number;
  unitCost: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  /** Stock of the product / chosen variant right now. */
  stock: number;
};

export type ComboResolution = {
  components: ResolvedComponent[];
  /** Price of ONE combo. */
  unitPrice: number;
  /** Canonical key: identical selections have identical keys (used to merge cart lines). */
  selectionKey: string;
};

export type ComboResult = { ok: true; value: ComboResolution } | { ok: false; message: string };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function fail(message: string): ComboResult {
  return { ok: false, message };
}

/** Resolves one component to a concrete product/variant, or explains why it can't be sold. */
function resolveComponent(
  product: ComboProduct,
  variantId: string | null,
  requireActive: boolean,
  requireVariantPin: boolean,
): { ok: true; variant: ComboVariant | null } | { ok: false; message: string } {
  if (product.kind === "COMBO") return { ok: false, message: `"${product.name}" is a combo and cannot be a component.` };
  if (requireActive && product.status !== "ACTIVE") {
    return { ok: false, message: `"${product.name}" is no longer available.` };
  }
  if (product.type === "VARIANT") {
    if (!variantId) {
      return requireVariantPin
        ? { ok: false, message: `"${product.name}" needs a specific option.` }
        : { ok: true, variant: null };
    }
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) return { ok: false, message: `That option of "${product.name}" is no longer available.` };
    return { ok: true, variant };
  }
  if (variantId) return { ok: false, message: `"${product.name}" does not have options.` };
  return { ok: true, variant: null };
}

function toResolved(
  product: ComboProduct,
  variant: ComboVariant | null,
  quantity: number,
  slot: { id: string; label: string } | null,
  optionId: string | null,
): ResolvedComponent {
  return {
    slotId: slot?.id ?? null,
    slotLabel: slot?.label ?? null,
    optionId,
    productId: product.id,
    variantId: variant?.id ?? null,
    productName: product.name,
    variantName: variant?.name ?? null,
    quantity,
    unitPrice: variant ? variant.price : product.price,
    unitCost: product.costPrice,
    trackInventory: product.trackInventory,
    // Components are never sold beyond physical stock (procurement applies to a line's own product only).
    allowBackorder: false,
    stock: variant ? variant.stock : product.stock,
  };
}

/**
 * Validates `selections` against the template and returns the exact components and the
 * price. Every id and quantity comes from untrusted client input and is checked here.
 */
export function resolveCombo(template: ComboTemplate, selections: unknown): ComboResult {
  const requireActive = template.stockPolicy === "COMPONENTS";

  if (template.mode === "FIXED") {
    if (Array.isArray(selections) && selections.length > 0) return fail("This combo has fixed contents.");
    if (template.fixedComponents.length === 0) return fail("This combo has no contents yet.");
    const components: ResolvedComponent[] = [];
    for (const c of template.fixedComponents) {
      const r = resolveComponent(c.product, c.variantId, requireActive, requireActive);
      if (!r.ok) return fail(r.message);
      components.push(toResolved(c.product, r.variant, c.quantity, null, null));
    }
    const unitPrice =
      template.pricing === "COMPONENT_SUM"
        ? round2(components.reduce((sum, c) => sum + c.unitPrice * c.quantity, 0))
        : round2(template.basePrice);
    return { ok: true, value: { components, unitPrice, selectionKey: "fixed" } };
  }

  // ---- CUSTOMIZABLE ----
  if (!Array.isArray(selections)) return fail("Please choose your items.");
  if (selections.length > MAX_COMBO_SELECTIONS) return fail("Too many selections.");

  const picked = new Map<string, { slotId: string; optionId: string; quantity: number }>();
  for (const raw of selections) {
    if (typeof raw !== "object" || raw === null) return fail("Invalid selection.");
    const { slotId, optionId, quantity } = raw as Record<string, unknown>;
    if (typeof slotId !== "string" || typeof optionId !== "string") return fail("Invalid selection.");
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COMPONENT_QTY) {
      return fail("Invalid quantity in your selection.");
    }
    const key = `${slotId}:${optionId}`;
    if (picked.has(key)) return fail("The same item was selected twice.");
    picked.set(key, { slotId, optionId, quantity });
  }

  const knownSlotIds = new Set(template.slots.map((s) => s.id));
  for (const sel of picked.values()) {
    if (!knownSlotIds.has(sel.slotId)) return fail("A selection does not belong to this combo.");
  }

  const components: ResolvedComponent[] = [];
  let surcharge = 0;
  for (const slot of template.slots) {
    const chosen = [...picked.values()].filter((s) => s.slotId === slot.id);
    const total = chosen.reduce((sum, s) => sum + s.quantity, 0);
    if (total < slot.minSelect) {
      return fail(
        slot.minSelect === 1 ? `Please choose an item for "${slot.label}".` : `Please choose at least ${slot.minSelect} for "${slot.label}".`,
      );
    }
    if (total > slot.maxSelect) return fail(`You can choose at most ${slot.maxSelect} for "${slot.label}".`);
    for (const sel of chosen) {
      const option = slot.options.find((o) => o.id === sel.optionId);
      if (!option) return fail(`That choice is not available for "${slot.label}".`);
      if (sel.quantity > slot.maxPerOption) {
        return fail(`You can choose at most ${slot.maxPerOption} of "${option.product.name}".`);
      }
      const r = resolveComponent(option.product, option.variantId, true, true);
      if (!r.ok) return fail(r.message);
      components.push(toResolved(option.product, r.variant, sel.quantity, slot, option.id));
      surcharge += option.priceDelta * sel.quantity;
    }
  }
  if (components.length === 0) return fail("Please choose your items.");

  const unitPrice =
    template.pricing === "COMPONENT_SUM"
      ? round2(components.reduce((sum, c) => sum + c.unitPrice * c.quantity, 0))
      : round2(template.basePrice + surcharge);
  const selectionKey = [...picked.values()]
    .map((s) => `${s.slotId}:${s.optionId}:${s.quantity}`)
    .sort()
    .join("|");
  return { ok: true, value: { components, unitPrice, selectionKey } };
}

/**
 * How many combos can be assembled right now. Only meaningful for the COMPONENTS stock
 * policy; untracked or backorder-allowed components never limit it. `Infinity` = unlimited.
 */
export function maxComboUnits(components: ResolvedComponent[]): number {
  let max = Infinity;
  for (const c of components) {
    if (!c.trackInventory || c.allowBackorder) continue;
    max = Math.min(max, Math.floor(Math.max(0, c.stock) / c.quantity));
  }
  return max;
}

export type StockDemand = { productId: string; variantId: string | null; quantity: number };

/** Units of each component needed for `comboQuantity` combos. */
export function componentDemand(components: ResolvedComponent[], comboQuantity: number): StockDemand[] {
  return components.map((c) => ({ productId: c.productId, variantId: c.variantId, quantity: c.quantity * comboQuantity }));
}

export const demandKey = (d: { productId: string; variantId: string | null }) => `${d.productId}:${d.variantId ?? ""}`;

/** Immutable record stored on the order item. */
export function buildComboSnapshot(template: ComboTemplate, resolution: ComboResolution) {
  return {
    version: 1,
    mode: template.mode,
    pricing: template.pricing,
    stockPolicy: template.stockPolicy,
    basePrice: round2(template.basePrice),
    unitPrice: resolution.unitPrice,
    components: resolution.components.map((c) => ({
      slot: c.slotLabel,
      productId: c.productId,
      variantId: c.variantId,
      name: c.productName,
      variant: c.variantName,
      quantity: c.quantity,
      unitPrice: c.unitPrice,
    })),
  };
}

// ---------------------------------------------------------------------------
// Admin-side rules
// ---------------------------------------------------------------------------

export type SlotRuleInput = { label: string; minSelect: number; maxSelect: number; maxPerOption: number };

export function validateSlotRules(s: SlotRuleInput): string | null {
  if (!s.label.trim()) return "A selection group needs a name.";
  if (![s.minSelect, s.maxSelect, s.maxPerOption].every(Number.isInteger)) return "Limits must be whole numbers.";
  if (s.minSelect < 0) return "Minimum cannot be negative.";
  if (s.maxSelect < 1) return "Maximum must be at least 1.";
  if (s.maxSelect < s.minSelect) return "Maximum cannot be smaller than the minimum.";
  if (s.maxPerOption < 1) return "Per-item limit must be at least 1.";
  if (s.maxSelect > MAX_COMBO_SELECTIONS) return `Maximum cannot exceed ${MAX_COMBO_SELECTIONS}.`;
  return null;
}

/** Product-level combo configuration rules shared by the form and the service. */
export function validateComboConfig(input: {
  kind: "SINGLE" | "COMBO";
  type: string;
  comboMode: ComboMode | null;
  comboPricing: ComboPricing | null;
  comboStockPolicy: ComboStockPolicy | null;
}): string | null {
  if (input.kind === "SINGLE") {
    if (input.type === "BUNDLE") return "A single product cannot use the combo shape.";
    return null;
  }
  if (input.type !== "BUNDLE") return "A combo must use the combo shape.";
  if (!input.comboMode || !input.comboPricing || !input.comboStockPolicy) return "Choose how the combo works.";
  if (input.comboMode === "CUSTOMIZABLE" && input.comboStockPolicy !== "COMPONENTS") {
    return "A customizable combo must use component stock.";
  }
  return null;
}
