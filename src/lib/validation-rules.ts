/**
 * Server-side business-rule validation shared by the admin actions and the
 * zod schemas. Pure functions returning a human-readable message (or null /
 * ok-result) so they are unit-testable without a database and independent of
 * the zod major version.
 */
import {
  CUSTOMIZATION_FIELD_TYPES,
  DEFAULT_TEXTAREA_MAX,
  DEFAULT_TEXT_MAX,
  MAX_FIELD_OPTIONS,
  MAX_OPTION_LENGTH,
  OPTION_FIELD_TYPES,
  TEXT_FIELD_TYPES,
  type CustomizationFieldConfig,
} from "@/lib/customization";

/** Decimal(10,2) ceiling — anything above overflows the column. */
export const MAX_MONEY = 99_999_999.99;
export const MAX_STOCK = 1_000_000;

function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

export function isValidMoney(n: unknown, opts: { min?: number } = {}): n is number {
  const min = opts.min ?? 0;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= MAX_MONEY && hasAtMostTwoDecimals(n);
}

// ---------------------------------------------------------------------------
// Variant options (Json column) — never blindly cast arbitrary JSON
// ---------------------------------------------------------------------------

export const MAX_VARIANT_OPTION_KEYS = 5;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type OptionsResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string };

/** Strict validation for admin input. */
export function parseVariantOptions(raw: unknown): OptionsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Options must be a JSON object, e.g. {"Color":"Terracotta"}.' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, message: "Add at least one option, e.g. Color." };
  if (entries.length > MAX_VARIANT_OPTION_KEYS) {
    return { ok: false, message: `Use at most ${MAX_VARIANT_OPTION_KEYS} option types per variant.` };
  }
  const value: Record<string, string> = Object.create(null);
  for (const [key, val] of entries) {
    const k = key.trim();
    if (!k || k.length > 40 || FORBIDDEN_KEYS.has(k)) {
      return { ok: false, message: "Option names must be 1–40 characters." };
    }
    if (typeof val !== "string" || !val.trim() || val.trim().length > 80) {
      return { ok: false, message: `The value for "${k}" must be text of 1–80 characters.` };
    }
    value[k] = val.trim();
  }
  return { ok: true, value: { ...value } };
}

export function parseVariantOptionsJson(json: string): OptionsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: 'Options must be valid JSON, e.g. {"Color":"Terracotta"}.' };
  }
  return parseVariantOptions(parsed);
}

/** Lenient read path (DB → storefront): keeps only valid string entries, never throws. */
export function readVariantOptions(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && !FORBIDDEN_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function optionSignature(options: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(options)
      .sort()
      .map((k) => [k.toLowerCase(), options[k].toLowerCase()]),
  );
}

/**
 * A variant must use the same option names as its siblings (so the
 * storefront selector is coherent) and must not duplicate a sibling's
 * option combination (ambiguous selection).
 */
export function checkVariantAgainstSiblings(
  options: Record<string, string>,
  siblings: readonly { id: string; options: unknown }[],
  editingId: string | null,
): string | null {
  const others = siblings.filter((s) => s.id !== editingId);
  if (others.length === 0) return null;

  const keys = Object.keys(options).map((k) => k.toLowerCase()).sort().join("|");
  const sig = optionSignature(options);
  for (const sibling of others) {
    const siblingOptions = readVariantOptions(sibling.options);
    const siblingKeys = Object.keys(siblingOptions).map((k) => k.toLowerCase()).sort().join("|");
    if (siblingKeys !== keys) {
      return "All variants must use the same option names (e.g. every variant has Color and Size).";
    }
    if (optionSignature(siblingOptions) === sig) {
      return "Another variant already has this exact option combination.";
    }
  }
  return null;
}

export type VariantRuleInput = { price: number; stock: number };

export function validateVariantRules(v: VariantRuleInput): string | null {
  if (!isValidMoney(v.price, { min: 0.01 })) return "Variant price must be greater than 0 (max 2 decimals).";
  if (!Number.isInteger(v.stock) || v.stock < 0 || v.stock > MAX_STOCK) {
    return "Variant stock must be a whole number of 0 or more.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export type ProductRuleInput = {
  type: "STANDARD" | "VARIANT" | "PERSONALIZED" | "BUNDLE";
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  price: number;
  compareAtPrice: number | null;
  costPrice: number | null;
  stock: number;
  lowStockThreshold: number;
  weightGrams: number | null;
};

export function validateProductRules(p: ProductRuleInput): string | null {
  if (!isValidMoney(p.price, { min: 0.01 })) return "Price must be greater than 0 (max 2 decimals).";
  if (p.compareAtPrice !== null) {
    if (!isValidMoney(p.compareAtPrice, { min: 0.01 })) return "Compare-at price is not a valid amount.";
    if (p.compareAtPrice <= p.price) return "Compare-at price must be higher than the selling price.";
  }
  if (p.costPrice !== null && !isValidMoney(p.costPrice)) return "Cost price is not a valid amount.";
  if (!Number.isInteger(p.stock) || p.stock < 0 || p.stock > MAX_STOCK) {
    return "Stock must be a whole number of 0 or more.";
  }
  if (!Number.isInteger(p.lowStockThreshold) || p.lowStockThreshold < 0 || p.lowStockThreshold > MAX_STOCK) {
    return "Low-stock threshold must be a whole number of 0 or more.";
  }
  if (p.weightGrams !== null && (!Number.isInteger(p.weightGrams) || p.weightGrams < 0)) {
    return "Weight must be a whole number of grams.";
  }
  return null;
}

/**
 * A product can only be ACTIVE (visible/purchasable) when its type's
 * required child data exists. Used on save, and when deleting the last
 * child of an ACTIVE product.
 */
export function activationRequirementError(args: {
  type: ProductRuleInput["type"];
  status: ProductRuleInput["status"];
  variantCount: number;
  customizationFieldCount: number;
  bundleItemCount: number;
}): string | null {
  if (args.status !== "ACTIVE") return null;
  if (args.type === "VARIANT" && args.variantCount < 1) {
    return "A variant product needs at least one variant before it can be Active. Save it as Draft first.";
  }
  if (args.type === "PERSONALIZED" && args.customizationFieldCount < 1) {
    return "A personalized product needs at least one personalization field before it can be Active. Save it as Draft first.";
  }
  if (args.type === "BUNDLE" && args.bundleItemCount < 1) {
    return "A bundle needs at least one component before it can be Active. Save it as Draft first.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundle items
// ---------------------------------------------------------------------------

export const MAX_BUNDLE_COMPONENT_QUANTITY = 99;

export function validateBundleItemRules(args: {
  bundleType: string;
  componentType: string;
  bundleId: string;
  componentId: string;
  quantity: number;
}): string | null {
  if (args.bundleType !== "BUNDLE") return "Components can only be added to a bundle product.";
  if (args.bundleId === args.componentId) return "A bundle can't contain itself.";
  if (args.componentType === "BUNDLE") return "A bundle can't contain another bundle.";
  if (
    !Number.isInteger(args.quantity) ||
    args.quantity < 1 ||
    args.quantity > MAX_BUNDLE_COMPONENT_QUANTITY
  ) {
    return `Component quantity must be a whole number between 1 and ${MAX_BUNDLE_COMPONENT_QUANTITY}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coupon
// ---------------------------------------------------------------------------

export type CouponRuleInput = {
  code: string;
  type: "PERCENTAGE" | "FIXED";
  value: number;
  minPurchase: number | null;
  maxDiscount: number | null;
  usageLimit: number | null;
  perUserLimit: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

export function validateCouponRules(c: CouponRuleInput): string | null {
  if (!/^[A-Z0-9_-]{3,32}$/.test(c.code)) {
    return "Coupon code must be 3–32 characters: letters, numbers, - or _.";
  }
  if (typeof c.value !== "number" || !Number.isFinite(c.value) || c.value <= 0) {
    return "Discount value must be greater than 0.";
  }
  if (c.type === "PERCENTAGE") {
    if (c.value > 100) return "A percentage discount can't be more than 100%.";
    if (!hasAtMostTwoDecimals(c.value)) return "Percentage can have at most 2 decimals.";
  } else if (!isValidMoney(c.value, { min: 0.01 })) {
    return "Fixed discount must be a valid amount (max 2 decimals).";
  }
  if (c.minPurchase !== null && !isValidMoney(c.minPurchase)) {
    return "Minimum purchase must be 0 or more.";
  }
  if (c.maxDiscount !== null) {
    if (c.type !== "PERCENTAGE") return "A maximum discount cap only applies to percentage coupons.";
    if (!isValidMoney(c.maxDiscount, { min: 0.01 })) return "Maximum discount must be greater than 0.";
  }
  if (c.usageLimit !== null && (!Number.isInteger(c.usageLimit) || c.usageLimit < 1)) {
    return "Usage limit must be a whole number of 1 or more (leave empty for unlimited).";
  }
  if (c.perUserLimit !== null && (!Number.isInteger(c.perUserLimit) || c.perUserLimit < 1)) {
    return "Per-customer limit must be a whole number of 1 or more (leave empty for unlimited).";
  }
  if (c.usageLimit !== null && c.perUserLimit !== null && c.perUserLimit > c.usageLimit) {
    return "Per-customer limit can't exceed the total usage limit.";
  }
  if (c.startsAt && Number.isNaN(c.startsAt.getTime())) return "Start date is not valid.";
  if (c.endsAt && Number.isNaN(c.endsAt.getTime())) return "End date is not valid.";
  if (c.startsAt && c.endsAt && c.startsAt.getTime() >= c.endsAt.getTime()) {
    return "The start date must be before the end date.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Customization field configuration (admin)
// ---------------------------------------------------------------------------

export function validateCustomizationFieldConfig(f: CustomizationFieldConfig & { sortOrder?: number }): string | null {
  if (!(CUSTOMIZATION_FIELD_TYPES as readonly string[]).includes(f.type)) {
    return "Unsupported field type.";
  }
  const label = f.label.trim();
  if (!label || label.length > 80) return "Label must be 1–80 characters.";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(f.fieldKey) || FORBIDDEN_KEYS.has(f.fieldKey)) {
    return "Field key must start with a letter and use only letters, numbers and underscores (max 40).";
  }
  if (f.sortOrder !== undefined && (!Number.isInteger(f.sortOrder) || f.sortOrder < 0 || f.sortOrder > 1000)) {
    return "Sort order must be a whole number between 0 and 1000.";
  }

  if (OPTION_FIELD_TYPES.includes(f.type)) {
    if (f.options.length < 1) return "Dropdown and color fields need at least one option.";
    if (f.options.length > MAX_FIELD_OPTIONS) return `Use at most ${MAX_FIELD_OPTIONS} options.`;
    const seen = new Set<string>();
    for (const option of f.options) {
      if (!option.trim() || option.length > MAX_OPTION_LENGTH) {
        return `Each option must be 1–${MAX_OPTION_LENGTH} characters.`;
      }
      const key = option.trim().toLowerCase();
      if (seen.has(key)) return `Duplicate option "${option}".`;
      seen.add(key);
    }
  } else if (f.options.length > 0) {
    return "Options only apply to dropdown and color fields.";
  }

  if (TEXT_FIELD_TYPES.includes(f.type)) {
    if (f.maxLength !== null) {
      const ceiling = f.type === "TEXT" ? DEFAULT_TEXT_MAX : DEFAULT_TEXTAREA_MAX;
      if (!Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > ceiling) {
        return `Max length must be between 1 and ${ceiling}.`;
      }
    }
  } else if (f.maxLength !== null) {
    return "Max length only applies to text fields.";
  }
  return null;
}
