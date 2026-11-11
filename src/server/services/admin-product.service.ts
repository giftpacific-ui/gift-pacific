import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { Prisma, ProductStatus, ProductType, ProductBadge, CustomizationFieldType, ComboMode, ComboPricing, ComboStockPolicy } from "@prisma/client";
import { validateComboConfig } from "@/lib/combo";
import { UserFacingError } from "@/lib/errors";
import { applyStockDelta } from "@/server/services/stock-adjustment.service";
import { isSafeImageUrl } from "@/lib/url-safety";
import { claimSlug, dropSlugRedirects, recordSlugChange } from "@/server/services/slug-redirect.service";
import {
  activationRequirementError,
  checkVariantAgainstSiblings,
  validateBundleItemRules,
  validateCustomizationFieldConfig,
  validateProductRules,
  validateVariantRules,
} from "@/lib/validation-rules";

export async function adminListProducts(params: { search?: string; page?: number; pageSize?: number }) {
  const { search, page = 1, pageSize = 20 } = params;
  const where: Prisma.ProductWhereInput = search
    ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { sku: { contains: search, mode: "insensitive" } }] }
    : {};

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: { category: true, images: { where: { isMain: true }, take: 1 } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return { items, total, page, pageCount: Math.ceil(total / pageSize) };
}

export async function adminGetProductById(id: string) {
  return prisma.product.findUnique({
    where: { id },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      variants: true,
      customizationFields: { orderBy: { sortOrder: "asc" } },
      bundleItems: { include: { component: true, variant: true } },
      category: true,
    },
  });
}

export type ProductFormInput = {
  name: string;
  slug: string;
  shortDescription?: string;
  description: string;
  sku?: string;
  brand?: string;
  type: ProductType;
  kind?: "SINGLE" | "COMBO";
  comboMode?: ComboMode | null;
  comboPricing?: ComboPricing | null;
  comboStockPolicy?: ComboStockPolicy | null;
  status: ProductStatus;
  badges: ProductBadge[];
  categoryId?: string | null;
  price: number;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  stock: number;
  lowStockThreshold: number;
  allowBackorder: boolean;
  procurementLimit?: number | null;
  backorderNote?: string | null;
  trackInventory: boolean;
  isFeatured: boolean;
  videoUrl?: string | null;
  weightGrams?: number | null;
  metaTitle?: string;
  metaDescription?: string;
  metaKeywords?: string[];
  seoImage?: string | null;
  seoNoIndex?: boolean;
};

/** Thrown when a child id doesn't belong to the parent it was used with (or doesn't exist). */
export class ChildNotFoundError extends UserFacingError {
  constructor(what: string) {
    super(`${what} not found for this product.`);
    this.name = "ChildNotFoundError";
  }
}

/**
 * Fills the combo configuration: callers that predate combos only send `type`, and a BUNDLE
 * then means exactly what it always did (fixed contents, fixed price, the box's own stock).
 */
function normalizeProductInput(input: ProductFormInput) {
  const kind = input.kind ?? (input.type === "BUNDLE" ? "COMBO" : "SINGLE");
  if (kind === "SINGLE") {
    return { ...input, kind, comboMode: null, comboPricing: null, comboStockPolicy: null } as const;
  }
  const comboMode = input.comboMode ?? "FIXED";
  return {
    ...input,
    kind,
    comboMode,
    comboPricing: input.comboPricing ?? "FIXED_PRICE",
    comboStockPolicy: input.comboStockPolicy ?? (comboMode === "CUSTOMIZABLE" ? "COMPONENTS" : "OWN_STOCK"),
  } as const;
}

/** A customizable combo can only go live when every group can actually be satisfied. */
async function customizableComboActivationError(
  tx: Prisma.TransactionClient,
  comboId: string,
  pricing: string | null | undefined,
): Promise<string | null> {
  const slots = await tx.comboSlot.findMany({ where: { comboId }, include: { options: { select: { id: true } } } });
  // `pricing` is the value being SAVED (not the stored one), so flipping an active combo to a fixed price is caught too.
  if (pricing !== "COMPONENT_SUM" && slots.some((s) => s.source === "CATALOG")) {
    return "A free-choice (any product) group needs the combo price set to “Sum of component prices”.";
  }
  // Catalog / box groups are built from live data: count what is actually offered right now.
  for (const s of slots) {
    if (s.source === "CATALOG") {
      const n = await tx.product.count({ where: { status: "ACTIVE", kind: "SINGLE", isBoxProduct: false, ...(s.categoryId ? { categoryId: s.categoryId } : {}) } });
      s.options = Array.from({ length: Math.min(n, 500) }, () => ({ id: "dynamic" }));
    } else if (s.source === "BOXES") {
      const n = await tx.box.count({ where: { isActive: true, product: { is: { status: "ACTIVE" } } } });
      s.options = Array.from({ length: n }, () => ({ id: "dynamic" }));
    }
  }
  if (slots.length === 0) return "A customizable combo needs at least one selection group before it can be Active. Save it as Draft first.";
  for (const slot of slots) {
    if (slot.options.length === 0) return `The group "${slot.label}" has no products to choose from yet.`;
    const capacity = Math.min(slot.maxSelect, slot.options.length * slot.maxPerOption);
    if (capacity < slot.minSelect) {
      return `The group "${slot.label}" requires at least ${slot.minSelect} but its products only allow ${capacity}.`;
    }
  }
  return null;
}

function assertProductRules(input: ProductFormInput) {
  const comboError = validateComboConfig({
    kind: input.kind ?? (input.type === "BUNDLE" ? "COMBO" : "SINGLE"),
    type: input.type,
    comboMode: input.comboMode ?? null,
    comboPricing: input.comboPricing ?? null,
    comboStockPolicy: input.comboStockPolicy ?? null,
  });
  if (comboError) throw new UserFacingError(comboError);
  const error = validateProductRules({
    type: input.type,
    status: input.status,
    price: input.price,
    compareAtPrice: input.compareAtPrice ?? null,
    costPrice: input.costPrice ?? null,
    stock: input.stock,
    lowStockThreshold: input.lowStockThreshold,
    weightGrams: input.weightGrams ?? null,
  });
  if (error) throw new UserFacingError(error);
}

// ---- Product ----

export type DraftVariantInput = VariantInput;

/**
 * Creates a product (and, for VARIANT products, its initial variants) in ONE
 * transaction. An ACTIVE product must satisfy its type's requirements at
 * creation time (e.g. a variant product needs >= 1 variant), so a broken
 * product can never become visible.
 */
export async function adminCreateProduct(rawInput: ProductFormInput, draftVariants: DraftVariantInput[] = []) {
  const input = normalizeProductInput(rawInput);
  assertProductRules(input);
  if (draftVariants.length > 0 && input.type !== "VARIANT") {
    throw new UserFacingError("Variants can only be added to a variant product.");
  }
  const requirement = activationRequirementError({
    type: input.type,
    status: input.status,
    variantCount: draftVariants.length,
    customizationFieldCount: 0,
    bundleItemCount: 0,
  });
  if (requirement) throw new UserFacingError(requirement);

  const seen: { id: string; options: unknown }[] = [];
  draftVariants.forEach((v, i) => {
    const rule = validateVariantRules(v);
    if (rule) throw new UserFacingError(`Variant ${i + 1}: ${rule}`);
    const clash = checkVariantAgainstSiblings(v.options, seen, null);
    if (clash) throw new UserFacingError(`Variant ${i + 1}: ${clash}`);
    seen.push({ id: String(i), options: v.options });
  });

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({ data: input });
    await claimSlug(tx, "PRODUCT", product.slug);
    let defaultAssigned = false;
    for (const v of draftVariants) {
      const isDefault: boolean = v.isDefault && !defaultAssigned;
      if (isDefault) defaultAssigned = true;
      await tx.productVariant.create({ data: { productId: product.id, ...variantColumns(v), isDefault } });
    }
    return product;
  });
}

/**
 * Updates a product. Stock is NOT written as an absolute value: a stale form
 * would otherwise overwrite stock that orders changed since the page loaded.
 * If `loadedStock` is given and the admin changed the stock field, only the
 * difference is applied (guarded, with history); an unchanged field leaves
 * stock completely alone. Without `loadedStock`, stock is never modified here.
 */
export async function adminUpdateProduct(
  id: string,
  rawInput: ProductFormInput,
  opts: { loadedStock?: number; adminId?: string | null } = {},
) {
  const input = normalizeProductInput(rawInput);
  assertProductRules(input);
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id }, select: { kind: true, slug: true } });
    if (input.kind === "COMBO" && current?.kind !== "COMBO") {
      // A combo may not be a component of another combo (no nesting, so stock never recurses).
      const [asComponent, asOption] = await Promise.all([
        tx.productBundleItem.count({ where: { componentId: id } }),
        tx.comboSlotOption.count({ where: { productId: id } }),
      ]);
      if (asComponent + asOption > 0) {
        throw new UserFacingError("This product is a component of a combo. Remove it from those combos before turning it into a combo.");
      }
    }
    if (input.kind === "SINGLE" && current?.kind === "COMBO") {
      // Turning a combo back into a single product discards its composition.
      await tx.comboSlot.deleteMany({ where: { comboId: id } });
      await tx.productBundleItem.deleteMany({ where: { bundleId: id } });
    }
    const [variantCount, customizationFieldCount, bundleItemCount] = await Promise.all([
      tx.productVariant.count({ where: { productId: id } }),
      tx.productCustomizationField.count({ where: { productId: id } }),
      tx.productBundleItem.count({ where: { bundleId: id } }),
    ]);
    const customizable = input.comboMode === "CUSTOMIZABLE";
    const requirement = activationRequirementError({
      type: input.type,
      status: input.status,
      variantCount,
      customizationFieldCount,
      // A customizable combo is composed of slots, not fixed bundle items.
      bundleItemCount: customizable ? 1 : bundleItemCount,
    });
    if (requirement) throw new UserFacingError(requirement);
    if (customizable && input.status === "ACTIVE") {
      const slotError = await customizableComboActivationError(tx, id, input.comboPricing);
      if (slotError) throw new UserFacingError(slotError);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { stock: _ignored, ...data } = input;
    const updated = await tx.product.update({ where: { id }, data });
    // A changed slug keeps the old URL alive as a permanent redirect.
    await recordSlugChange(tx, "PRODUCT", id, current?.slug, updated.slug);
    if (opts.loadedStock !== undefined && input.stock !== opts.loadedStock) {
      await applyStockDelta(tx, {
        productId: id,
        variantId: null,
        delta: input.stock - opts.loadedStock,
        reason: "Edited in product form",
        adminId: opts.adminId ?? null,
      });
    }
    return updated;
  });
}

export async function adminDeleteProduct(id: string) {
  return prisma.$transaction(async (tx) => {
    await dropSlugRedirects(tx, "PRODUCT", id);
    return tx.product.delete({ where: { id } });
  });
}

/** Guards deleting the last child of an ACTIVE product that needs it. */
async function assertNotRemovingLastChild(
  tx: Prisma.TransactionClient,
  productId: string,
  child: "variant" | "field" | "bundleItem",
) {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { type: true, status: true },
  });
  if (!product) throw new ChildNotFoundError("Product");
  const [variantCount, customizationFieldCount, bundleItemCount] = await Promise.all([
    tx.productVariant.count({ where: { productId } }),
    tx.productCustomizationField.count({ where: { productId } }),
    tx.productBundleItem.count({ where: { bundleId: productId } }),
  ]);
  const error = activationRequirementError({
    type: product.type,
    status: product.status,
    variantCount: child === "variant" ? variantCount - 1 : variantCount,
    customizationFieldCount: child === "field" ? customizationFieldCount - 1 : customizationFieldCount,
    bundleItemCount: child === "bundleItem" ? bundleItemCount - 1 : bundleItemCount,
  });
  if (error) {
    throw new UserFacingError(
      "This is the last one an Active product needs. Set the product to Draft before removing it.",
    );
  }
}

// ---- Images (every operation is scoped to its parent product) ----
export async function adminAddProductImage(
  productId: string,
  url: string,
  isMain: boolean,
  cloudinaryPublicId?: string | null,
) {
  if (!isSafeImageUrl(url)) throw new UserFacingError("Image URL must be a valid http(s) link.");
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new ChildNotFoundError("Product");
    if (isMain) {
      await tx.productImage.updateMany({ where: { productId }, data: { isMain: false } });
    }
    const count = await tx.productImage.count({ where: { productId } });
    return tx.productImage.create({
      data: { productId, url, isMain, sortOrder: count, cloudinaryPublicId: cloudinaryPublicId ?? null },
    });
  });
}

/** Returns the image only if it belongs to `productId`. */
export async function adminGetProductImage(productId: string, imageId: string) {
  return prisma.productImage.findFirst({ where: { id: imageId, productId } });
}

/** Deletes the image only if it belongs to `productId`; returns the deleted row's data. */
export async function adminDeleteProductImage(productId: string, imageId: string) {
  return prisma.$transaction(async (tx) => {
    const image = await tx.productImage.findFirst({ where: { id: imageId, productId } });
    if (!image) throw new ChildNotFoundError("Image");
    const deleted = await tx.productImage.deleteMany({ where: { id: imageId, productId } });
    if (deleted.count !== 1) throw new ChildNotFoundError("Image");
    return image;
  });
}

/**
 * True if this exact image URL was snapshotted onto any order line item.
 * Used to guard Cloudinary deletions — an image still referenced by order
 * history should never be deleted from Cloudinary, even if it's been
 * removed from the live product, so past invoices/order pages don't break.
 */
export async function isImageUrlReferencedByOrders(url: string) {
  const match = await prisma.orderItem.findFirst({ where: { imageUrl: url } });
  return match !== null;
}

/**
 * True when any record still references this Cloudinary asset, by URL or by public id. Checked before discarding an
 * upload that was never attached to a product, so an asset shared with another record is never deleted.
 */
export async function isCloudinaryAssetReferenced(publicId: string, url: string) {
  const select = { id: true } as const;
  const hits = await Promise.all([
    prisma.productImage.findFirst({ where: { OR: [{ url }, { cloudinaryPublicId: publicId }] }, select }),
    prisma.productVariant.findFirst({ where: { image: url }, select }),
    prisma.orderItem.findFirst({ where: { imageUrl: url }, select }),
    prisma.category.findFirst({ where: { image: url }, select }),
    prisma.collection.findFirst({ where: { image: url }, select }),
    prisma.storeSettings.findFirst({ where: { logoUrl: url }, select }),
    prisma.banner.findFirst({ where: { OR: [{ imageUrl: url }, { cloudinaryPublicId: publicId }] }, select }),
    prisma.box.findFirst({ where: { imageUrl: url }, select }),
    prisma.teamMember.findFirst({ where: { imageUrl: url }, select }),
  ]);
  return hits.some((h) => h !== null);
}

/** Descriptive alt text for a product photo (empty clears it, so the storefront falls back to "<name> — photo n"). */
export async function adminSetProductImageAlt(productId: string, imageId: string, altText: string | null) {
  const result = await prisma.productImage.updateMany({ where: { id: imageId, productId }, data: { altText } });
  if (result.count !== 1) throw new ChildNotFoundError("Image");
}

export async function adminSetMainProductImage(productId: string, imageId: string) {
  return prisma.$transaction(async (tx) => {
    const image = await tx.productImage.findFirst({ where: { id: imageId, productId } });
    if (!image) throw new ChildNotFoundError("Image");
    await tx.productImage.updateMany({ where: { productId }, data: { isMain: false } });
    await tx.productImage.updateMany({ where: { id: imageId, productId }, data: { isMain: true } });
    return image;
  });
}

/** Persists a new left-to-right order for a product's gallery images. */
export async function adminReorderProductImages(productId: string, orderedImageIds: string[]) {
  if (new Set(orderedImageIds).size !== orderedImageIds.length) {
    throw new UserFacingError("Duplicate images in the new order.");
  }
  await prisma.$transaction(async (tx) => {
    const owned = await tx.productImage.count({ where: { id: { in: orderedImageIds }, productId } });
    if (owned !== orderedImageIds.length) throw new ChildNotFoundError("Image");
    for (const [index, id] of orderedImageIds.entries()) {
      await tx.productImage.updateMany({ where: { id, productId }, data: { sortOrder: index } });
    }
  });
}

// ---- Variants ----
export type VariantInput = {
  name: string;
  sku: string;
  price: number;
  options: Record<string, string>;
  stock: number;
  image?: string;
  allowBackorder: boolean;
  isDefault: boolean;
  /** Stock when the admin opened the edit form (updates only) — see adminUpdateVariant. */
  loadedStock?: number;
};

/** The columns to persist (drops form-only fields). */
function variantColumns(input: VariantInput) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { loadedStock: _loaded, ...columns } = input;
  return columns;
}

function assertVariantInput(input: VariantInput) {
  const rule = validateVariantRules(input);
  if (rule) throw new UserFacingError(rule);
  if (input.image && !isSafeImageUrl(input.image)) {
    throw new UserFacingError("Variant image must be a valid http(s) link.");
  }
}

export async function adminCreateVariant(productId: string, input: VariantInput) {
  assertVariantInput(input);
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { type: true } });
    if (!product) throw new ChildNotFoundError("Product");
    if (product.type !== "VARIANT") {
      throw new UserFacingError("Variants can only be added to a variant product.");
    }
    const siblings = await tx.productVariant.findMany({
      where: { productId },
      select: { id: true, options: true },
    });
    const clash = checkVariantAgainstSiblings(input.options, siblings, null);
    if (clash) throw new UserFacingError(clash);

    if (input.isDefault) {
      await tx.productVariant.updateMany({ where: { productId }, data: { isDefault: false } });
    }
    return tx.productVariant.create({ data: { productId, ...variantColumns(input) } });
  });
}

export async function adminUpdateVariant(
  productId: string,
  variantId: string,
  input: VariantInput,
  opts: { adminId?: string | null } = {},
) {
  assertVariantInput(input);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!existing) throw new ChildNotFoundError("Variant");

    const siblings = await tx.productVariant.findMany({
      where: { productId },
      select: { id: true, options: true },
    });
    const clash = checkVariantAgainstSiblings(input.options, siblings, variantId);
    if (clash) throw new UserFacingError(clash);

    if (input.isDefault) {
      await tx.productVariant.updateMany({ where: { productId }, data: { isDefault: false } });
    }
    // Stock is applied as a guarded RELATIVE change (see adminUpdateProduct).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { stock: _ignored, ...data } = variantColumns(input);
    const updated = await tx.productVariant.updateMany({
      where: { id: variantId, productId },
      data,
    });
    if (updated.count !== 1) throw new ChildNotFoundError("Variant");
    if (input.loadedStock !== undefined && input.stock !== input.loadedStock) {
      await applyStockDelta(tx, {
        productId,
        variantId,
        delta: input.stock - input.loadedStock,
        reason: "Edited in variant form",
        adminId: opts.adminId ?? null,
      });
    }
    return existing;
  });
}

export async function adminDeleteVariant(productId: string, variantId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!existing) throw new ChildNotFoundError("Variant");
    await assertNotRemovingLastChild(tx, productId, "variant");
    const deleted = await tx.productVariant.deleteMany({ where: { id: variantId, productId } });
    if (deleted.count !== 1) throw new ChildNotFoundError("Variant");
    return existing;
  });
}

// ---- Customization fields ----
export type CustomizationFieldInput = {
  label: string;
  fieldKey: string;
  type: CustomizationFieldType;
  isRequired: boolean;
  options: string[];
  maxLength?: number | null;
  sortOrder: number;
};

function assertFieldInput(input: CustomizationFieldInput) {
  const error = validateCustomizationFieldConfig({
    label: input.label,
    fieldKey: input.fieldKey,
    type: input.type,
    isRequired: input.isRequired,
    options: input.options,
    maxLength: input.maxLength ?? null,
    sortOrder: input.sortOrder,
  });
  if (error) throw new UserFacingError(error);
}

export async function adminAddCustomizationField(productId: string, input: CustomizationFieldInput) {
  assertFieldInput(input);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { type: true } });
  if (!product) throw new ChildNotFoundError("Product");
  if (product.type !== "PERSONALIZED") {
    throw new UserFacingError("Personalization fields can only be added to a personalized product.");
  }
  return prisma.productCustomizationField.create({ data: { productId, ...input } });
}

export async function adminUpdateCustomizationField(
  productId: string,
  fieldId: string,
  input: CustomizationFieldInput,
) {
  assertFieldInput(input);
  const updated = await prisma.productCustomizationField.updateMany({
    where: { id: fieldId, productId },
    data: input,
  });
  if (updated.count !== 1) throw new ChildNotFoundError("Field");
}

export async function adminDeleteCustomizationField(productId: string, fieldId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.productCustomizationField.findFirst({ where: { id: fieldId, productId } });
    if (!existing) throw new ChildNotFoundError("Field");
    await assertNotRemovingLastChild(tx, productId, "field");
    const deleted = await tx.productCustomizationField.deleteMany({ where: { id: fieldId, productId } });
    if (deleted.count !== 1) throw new ChildNotFoundError("Field");
  });
}

// ---- Bundle items ----
// Bundle inventory model: a bundle has its OWN stock (pre-assembled boxes);
// components are descriptive and never consumed. See lib/stock.ts.
export async function adminAddBundleItem(
  bundleId: string,
  componentId: string,
  quantity: number,
  variantId: string | null = null,
) {
  const [bundle, component] = await Promise.all([
    prisma.product.findUnique({ where: { id: bundleId }, select: { id: true, type: true, kind: true, comboMode: true, comboStockPolicy: true } }),
    prisma.product.findUnique({ where: { id: componentId }, select: { id: true, type: true, kind: true, variants: { select: { id: true } } } }),
  ]);
  if (!bundle) throw new ChildNotFoundError("Bundle");
  if (!component) throw new UserFacingError("Component product not found.");
  const error = validateBundleItemRules({
    bundleType: bundle.type,
    componentType: component.type,
    bundleId,
    componentId,
    quantity,
  });
  if (error) throw new UserFacingError(error);
  if (bundle.comboMode === "CUSTOMIZABLE") {
    throw new UserFacingError("A customizable combo uses selection groups instead of fixed components.");
  }
  if (component.kind === "COMBO") throw new UserFacingError("A combo cannot contain another combo.");
  if (component.type === "VARIANT") {
    // When the combo consumes COMPONENT stock the exact variant must be pinned; for a
    // pre-assembled box (own stock) the list is descriptive and a pin is optional.
    const pinRequired = bundle.comboStockPolicy === "COMPONENTS";
    if ((pinRequired && !variantId) || (variantId && !component.variants.some((v) => v.id === variantId))) {
      throw new UserFacingError("Choose which option of that product goes in the combo.");
    }
  } else if (variantId) {
    throw new UserFacingError("That product has no options.");
  }
  return prisma.productBundleItem.create({ data: { bundleId, componentId, quantity, variantId } });
}

export async function adminDeleteBundleItem(bundleId: string, bundleItemId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.productBundleItem.findFirst({ where: { id: bundleItemId, bundleId } });
    if (!existing) throw new ChildNotFoundError("Bundle item");
    await assertNotRemovingLastChild(tx, bundleId, "bundleItem");
    const deleted = await tx.productBundleItem.deleteMany({ where: { id: bundleItemId, bundleId } });
    if (deleted.count !== 1) throw new ChildNotFoundError("Bundle item");
  });
}

export async function adminSearchProductsForBundle(search: string, excludeId: string) {
  const rows = await prisma.product.findMany({
    where: {
      name: { contains: search, mode: "insensitive" },
      id: { not: excludeId },
      kind: "SINGLE",
    },
    select: { id: true, name: true, price: true, type: true, variants: { select: { id: true, name: true }, orderBy: { name: "asc" } } },
    take: 10,
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price),
    isVariantProduct: r.type === "VARIANT",
    variants: r.variants,
  }));
}
