/**
 * PUBLIC product shapes — the only product data that may reach a Client
 * Component, a Server Action return value, or the browser in any form.
 *
 * Why this exists: the storefront used to pass full Prisma `Product` rows
 * (with `include`) across the RSC boundary, which shipped `costPrice`, raw
 * stock counts, SKUs of variants, bundle component rows (with THEIR
 * costPrice) etc. to every visitor. Here every output field is picked
 * explicitly (an allow-list — never `...spread`), so a new column added to
 * the database can't leak by accident.
 *
 * NOT exposed, deliberately: costPrice, lowStockThreshold, allowBackorder,
 * trackInventory, raw stock counts, variant SKUs, bundle item/component ids,
 * customization field ids, categoryId, createdAt/updatedAt, status.
 *
 * Pure module (no server-only / prisma runtime imports) so it's unit-tested.
 */
import {
  getProductAvailability,
  getVariantAvailability,
  type Availability,
  type ProductTypeName,
} from "@/lib/stock";
import { readVariantOptions } from "@/lib/validation-rules";
import { sanitizeProductHtml } from "@/lib/sanitize-html";
import type { CustomizationFieldTypeName } from "@/lib/customization";

type DecimalLike = number | string | { toNumber(): number };

export function toNumber(value: DecimalLike): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return value.toNumber();
}

// ---- Raw (database-shaped) inputs: what the Prisma `select`s return ------

export type RawCardProduct = {
  kind?: string;
  comboMode?: string | null;
  comboStockPolicy?: string | null;
  id: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  type: ProductTypeName;
  badges: readonly string[];
  currency: string;
  price: DecimalLike;
  compareAtPrice: DecimalLike | null;
  videoUrl: string | null;
  stock: number;
  allowBackorder: boolean;
  trackInventory: boolean;
  images: readonly { url: string; altText: string | null }[];
  category: { name: string; slug: string } | null;
  variants: readonly { price: DecimalLike; stock: number; allowBackorder: boolean }[];
};

export type RawDetailProduct = Omit<RawCardProduct, "variants"> & {
  description: string;
  sku: string | null;
  variants: readonly {
    id: string;
    name: string;
    price: DecimalLike;
    options: unknown;
    image: string | null;
    isDefault: boolean;
    stock: number;
    allowBackorder: boolean;
  }[];
  customizationFields: readonly {
    label: string;
    fieldKey: string;
    type: string;
    isRequired: boolean;
    options: readonly string[];
    maxLength: number | null;
  }[];
  bundleItems: readonly {
    quantity: number;
    component: { name: string; images: readonly { url: string }[] };
  }[];
};

// ---- Public outputs -------------------------------------------------------

export type PublicImage = { url: string; altText: string | null };

export type PublicAvailability = Availability;

export type PublicProductCard = {
  id: string;
  name: string;
  slug: string;
  shortDescription: string | null;
    type: ProductTypeName;
  /** Explicit product type: a normal product or a combo made of other products. */
  kind: "SINGLE" | "COMBO";
  comboMode: "FIXED" | "CUSTOMIZABLE" | null;
  badges: string[];
  currency: string;
  /** Price to display: for VARIANT products, the lowest *purchasable* variant price. */
  price: number;
  /** Only set when it is genuinely higher than `price` (i.e. the item is on sale). */
  compareAtPrice: number | null;
  videoUrl: string | null;
  images: PublicImage[];
  category: { name: string; slug: string } | null;
  availability: PublicAvailability;
};

export type PublicVariant = {
  id: string;
  name: string;
  price: number;
  options: Record<string, string>;
  image: string | null;
  isDefault: boolean;
  inStock: boolean;
  /** null = unlimited */
  maxQuantity: number | null;
};

export type PublicCustomizationField = {
  label: string;
  fieldKey: string;
  type: CustomizationFieldTypeName;
  isRequired: boolean;
  options: string[];
  maxLength: number | null;
};

export type PublicBundleComponent = {
  name: string;
  quantity: number;
  imageUrl: string | null;
};

/**
 * What a customer may pick in a CUSTOMIZABLE combo. Display data only: the server re-validates
 * every selection and decides the price. No cost, no raw stock counts.
 */
export type PublicComboBuilder = {
  pricing: "FIXED_PRICE" | "COMPONENT_SUM";
  basePrice: number;
  slots: {
    id: string;
    label: string;
    helpText: string | null;
    minSelect: number;
    maxSelect: number;
    maxPerOption: number;
    options: {
      id: string;
      name: string;
      variantName: string | null;
      image: string | null;
      /** Unit price of the item itself (shown for COMPONENT_SUM combos). */
      price: number;
      /** Extra charge for picking this item (FIXED_PRICE combos). */
      priceDelta: number;
      available: boolean;
      /** Most the customer can pick of this item (null = no stock limit). */
      maxQuantity: number | null;
    }[];
  }[];
};

export type PublicProductDetail = PublicProductCard & {
  combo: PublicComboBuilder | null;
  description: string;
  sku: string | null;
  variants: PublicVariant[];
  customizationFields: PublicCustomizationField[];
  bundleComponents: PublicBundleComponent[];
};

// ---- Mappers --------------------------------------------------------------

const SUPPORTED_FIELD_TYPES: readonly string[] = ["TEXT", "TEXTAREA", "DATE", "COLOR", "SELECT"];

function displayPriceFor(raw: {
  type: ProductTypeName;
  price: DecimalLike;
  trackInventory: boolean;
  variants: readonly { price: DecimalLike; stock: number; allowBackorder: boolean }[];
}): number {
  if (raw.type === "VARIANT" && raw.variants.length > 0) {
    const purchasable = raw.variants.filter(
      (v) => getVariantAvailability(v, raw.trackInventory).inStock,
    );
    const pool = purchasable.length > 0 ? purchasable : raw.variants;
    return Math.min(...pool.map((v) => toNumber(v.price)));
  }
  return toNumber(raw.price);
}

export function toPublicProductCard(raw: RawCardProduct): PublicProductCard {
  const price = displayPriceFor(raw);
  const compareAt = raw.compareAtPrice == null ? null : toNumber(raw.compareAtPrice);

  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    shortDescription: raw.shortDescription,
        type: raw.type,
    kind: raw.kind === "COMBO" ? "COMBO" : "SINGLE",
    comboMode: raw.kind === "COMBO" && (raw.comboMode === "FIXED" || raw.comboMode === "CUSTOMIZABLE") ? raw.comboMode : null,
    badges: [...raw.badges],
    currency: raw.currency,
    price,
    compareAtPrice: compareAt !== null && compareAt > price ? compareAt : null,
    videoUrl: raw.videoUrl,
    images: raw.images.map((i) => ({ url: i.url, altText: i.altText ?? null })),
    category: raw.category ? { name: raw.category.name, slug: raw.category.slug } : null,
        // A combo that draws on its components' stock has no stock of its own: lists stay
    // neutral (never a false "sold out"); the product page computes the real availability.
    availability:
      raw.kind === "COMBO" && raw.comboStockPolicy === "COMPONENTS"
        ? { inStock: true, maxQuantity: null }
        : getProductAvailability({
            type: raw.type,
            stock: raw.stock,
            allowBackorder: raw.allowBackorder,
            trackInventory: raw.trackInventory,
            variants: raw.variants,
          }),
  };
}

export function toPublicProductDetail(raw: RawDetailProduct): PublicProductDetail {
  const card = toPublicProductCard(raw);

    return {
    ...card,
    combo: null, // filled in by the product service for customizable combos
    // Sanitized on write AND again here, so legacy/seeded/imported rows can't inject markup.
    description: sanitizeProductHtml(raw.description),
    sku: raw.sku,
    variants: raw.variants.map((v) => {
      const availability = getVariantAvailability(v, raw.trackInventory);
      return {
        id: v.id,
        name: v.name,
        price: toNumber(v.price),
        options: readVariantOptions(v.options),
        image: v.image,
        isDefault: v.isDefault,
        inStock: availability.inStock,
        maxQuantity: availability.maxQuantity,
      };
    }),
    customizationFields: raw.customizationFields
      .filter((f) => SUPPORTED_FIELD_TYPES.includes(f.type))
      .map((f) => ({
        label: f.label,
        fieldKey: f.fieldKey,
        type: f.type as CustomizationFieldTypeName,
        isRequired: f.isRequired,
        options: [...f.options],
        maxLength: f.maxLength,
      })),
    bundleComponents: raw.bundleItems.map((b) => ({
      name: b.component.name,
      quantity: b.quantity,
      imageUrl: b.component.images[0]?.url ?? null,
    })),
  };
}

// ---- Reviews (server-rendered only, but still allow-listed) ---------------

export type PublicReview = {
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: Date;
  /** "Jamie R." — never the full customer name. */
  reviewerName: string;
  /** True when the review is tied to a delivered order item of the reviewer (all reviews written since verification began). */
  verifiedPurchase: boolean;
};

export function shortReviewerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export function toPublicReview(raw: {
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: Date;
  user: { name: string };
  orderItemId?: string | null;
}): PublicReview {
  return {
    rating: raw.rating,
    title: raw.title,
    body: raw.body,
    createdAt: raw.createdAt,
    reviewerName: shortReviewerName(raw.user.name),
    verifiedPurchase: !!raw.orderItemId,
  };
}

// ---- Guard used by tests (and usable in dev assertions) -------------------

/**
 * Keys that must never appear anywhere inside public product data.
 * (`sku` is intentionally public on the detail page; variant SKUs are not
 * exposed because PublicVariant has no `sku` field — asserted in tests.)
 */
export const FORBIDDEN_PUBLIC_PRODUCT_KEYS = [
  "costPrice",
  "lowStockThreshold",
  "allowBackorder",
  "trackInventory",
  "stock",
  "status",
  "categoryId",
  "createdAt",
  "updatedAt",
  "bundleItems",
  "usedInBundles",
  "orderItems",
  "cartItems",
  "passwordHash",
] as const;
