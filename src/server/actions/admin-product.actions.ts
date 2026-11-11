"use server";

import { normalizeKeywords } from "@/lib/seo-keywords";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { sanitizeProductHtml } from "@/lib/sanitize-html";
import {
  productFormSchema,
  variantFormSchema,
  customizationFieldFormSchema,
} from "@/lib/validations/admin";
import {
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminAddProductImage,
  adminGetProductImage,
  adminDeleteProductImage,
  adminSetMainProductImage,
  adminSetProductImageAlt,
  adminReorderProductImages,
  adminCreateVariant,
  adminUpdateVariant,
  adminDeleteVariant,
  adminAddCustomizationField,
  adminUpdateCustomizationField,
  adminDeleteCustomizationField,
  adminAddBundleItem,
  adminDeleteBundleItem,
  adminSearchProductsForBundle,
  isImageUrlReferencedByOrders,
  adminGetProductById,
  type VariantInput,
} from "@/server/services/admin-product.service";
import { deleteImageFromCloudinary } from "@/lib/cloudinary/cloudinary";
import { toUserMessage } from "@/lib/errors";
import { parseVariantOptionsJson } from "@/lib/validation-rules";

export type AdminActionResult =
  | { success: true; id?: string }
  | { success: false; message: string };

function toNullableNumber(value: number | "" | undefined): number | null {
  return value === "" || value === undefined ? null : value;
}

/** Parses + validates one variant form payload into the service input (no blind JSON casts). */
function parseVariant(raw: unknown): { ok: true; value: VariantInput } | { ok: false; message: string } {
  const parsed = variantFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const options = parseVariantOptionsJson(parsed.data.optionsJson);
  if (!options.ok) return options;
  return {
    ok: true,
    value: {
      name: parsed.data.name,
      sku: parsed.data.sku,
      price: parsed.data.price,
      options: options.value,
      stock: parsed.data.stock,
      image: parsed.data.image || undefined,
      allowBackorder: parsed.data.allowBackorder,
      isDefault: parsed.data.isDefault,
      loadedStock: parsed.data.loadedStock,
    },
  };
}

export async function saveProductAction(
  productId: string | null,
  raw: Record<string, unknown>,
  draftVariants?: Record<string, unknown>[],
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const parsed = productFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const data = {
    name: parsed.data.name,
    slug: parsed.data.slug,
    shortDescription: parsed.data.shortDescription || undefined,
    description: sanitizeProductHtml(parsed.data.description),
    sku: parsed.data.sku || undefined,
    brand: parsed.data.brand || undefined,
    type: parsed.data.type,
    kind: parsed.data.kind, // undefined => derived from `type`
    comboMode: parsed.data.comboMode || null,
    comboPricing: parsed.data.comboPricing || null,
    comboStockPolicy: parsed.data.comboStockPolicy || null,
    status: parsed.data.status,
    badges: parsed.data.badges,
    categoryId: parsed.data.categoryId || null,
    price: parsed.data.price,
    compareAtPrice: toNullableNumber(parsed.data.compareAtPrice),
    costPrice: toNullableNumber(parsed.data.costPrice),
    stock: parsed.data.stock,
    lowStockThreshold: parsed.data.lowStockThreshold,
    allowBackorder: parsed.data.allowBackorder,
    // "" / missing clears the cap; the pending counter itself is never editable here.
    procurementLimit: parsed.data.procurementLimit === "" || parsed.data.procurementLimit === undefined ? null : parsed.data.procurementLimit,
    backorderNote: parsed.data.backorderNote?.trim() || null,
    trackInventory: parsed.data.trackInventory,
    isFeatured: parsed.data.isFeatured,
    videoUrl: parsed.data.videoUrl || undefined,
    weightGrams: toNullableNumber(parsed.data.weightGrams),
    metaTitle: parsed.data.metaTitle || undefined,
    metaDescription: parsed.data.metaDescription || undefined,
    // Always sent (even empty) so clearing every tag in the form actually clears the stored list.
    metaKeywords: normalizeKeywords(parsed.data.metaKeywords),
    seoImage: parsed.data.seoImage?.trim() || null,
    seoNoIndex: parsed.data.seoNoIndex === true,
  };

  try {
    let product: { id: string };
    if (productId) {
      product = await adminUpdateProduct(productId, data, {
        loadedStock: parsed.data.loadedStock,
        adminId: admin.id,
      });
    } else {
      // Draft variants entered inline during create (before a valid
      // variant.productId FK exists). A malformed draft variant now FAILS
      // the save with a clear message instead of being silently dropped.
      const variants: VariantInput[] = [];
      for (const [index, rawVariant] of (draftVariants ?? []).entries()) {
        const parsedVariant = parseVariant(rawVariant);
        if (!parsedVariant.ok) {
          return { success: false, message: `Variant ${index + 1}: ${parsedVariant.message}` };
        }
        variants.push(parsedVariant.value);
      }
      product = await adminCreateProduct(data, data.type === "VARIANT" ? variants : []);
    }

    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${product.id}`);
    // Public side: the product page, the listing and the sitemap reflect the change straight away.
    revalidatePath(`/products/${parsed.data.slug}`);
    revalidatePath("/shop");
    revalidatePath("/sitemap.xml");
    return { success: true, id: product.id };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { success: false, message: "A product with this slug or SKU already exists." };
    }
    return { success: false, message: toUserMessage(error, "Could not save product.") };
  }
}

export async function deleteProductAction(productId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    // Clean up any Cloudinary assets that aren't referenced by past orders
    // before removing the product — otherwise those assets are orphaned in
    // Cloudinary forever (the ProductImage rows cascade-delete with the
    // product). Images still referenced by order history are deliberately
    // left in Cloudinary so past invoices/orders keep working.
    const product = await adminGetProductById(productId);
    if (product) {
      for (const image of product.images) {
        if (!image.cloudinaryPublicId) continue;
        const stillReferenced = await isImageUrlReferencedByOrders(image.url);
        if (!stillReferenced) {
          await deleteImageFromCloudinary(image.cloudinaryPublicId);
        }
      }
    }

    await adminDeleteProduct(productId);
    revalidatePath("/admin/products");
    return { success: true };
  } catch {
    return { success: false, message: "Could not delete product. It may be referenced by existing orders." };
  }
}

export async function addProductImageAction(
  productId: string,
  url: string,
  isMain: boolean,
  cloudinaryPublicId?: string | null,
): Promise<AdminActionResult & { imageId?: string }> {
  await requireAdmin();
  if (!url.trim()) return { success: false, message: "Image URL is required." };
  try {
    const image = await adminAddProductImage(productId, url.trim(), isMain, cloudinaryPublicId);
    revalidatePath(`/admin/products/${productId}`);
    return { success: true, imageId: image.id };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not add the image.") };
  }
}

export async function updateProductImageAltAction(
  imageId: string,
  productId: string,
  altText: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  const clean = altText.replace(/\s+/g, " ").trim();
  if (clean.length > 200) return { success: false, message: "Alt text can be at most 200 characters." };
  try {
    await adminSetProductImageAlt(productId, imageId, clean || null);
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the description.") };
  }
}

export async function deleteProductImageAction(
  imageId: string,
  productId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    // Ownership is enforced inside the service: the image must belong to productId.
    const image = await adminDeleteProductImage(productId, imageId);
    if (image.cloudinaryPublicId) {
      // Never delete an asset that's still referenced by a past order's
      // snapshot — that would break the image on an existing invoice/order
      // page even though the product itself is unaffected.
      const stillReferenced = await isImageUrlReferencedByOrders(image.url);
      if (!stillReferenced) {
        await deleteImageFromCloudinary(image.cloudinaryPublicId);
      }
    }
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the image.") };
  }
}

export async function setMainProductImageAction(
  productId: string,
  imageId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminSetMainProductImage(productId, imageId);
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not set the main image.") };
  }
}

export async function reorderProductImagesAction(
  productId: string,
  orderedImageIds: string[],
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminReorderProductImages(productId, orderedImageIds);
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not reorder the images.") };
  }
}

export async function saveVariantAction(
  productId: string,
  variantId: string | null,
  raw: Record<string, unknown>,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const parsed = parseVariant(raw);
  if (!parsed.ok) return { success: false, message: parsed.message };

  try {
    if (variantId) {
      await adminUpdateVariant(productId, variantId, parsed.value, { adminId: admin.id });
    } else {
      await adminCreateVariant(productId, parsed.value);
    }
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { success: false, message: "Could not save variant — that SKU is already in use." };
    }
    return { success: false, message: toUserMessage(error, "Could not save variant.") };
  }
}

export async function deleteVariantAction(
  variantId: string,
  productId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteVariant(productId, variantId);
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the variant.") };
  }
}

export async function saveCustomizationFieldAction(
  productId: string,
  fieldId: string | null,
  raw: Record<string, unknown>,
): Promise<AdminActionResult> {
  await requireAdmin();
  const parsed = customizationFieldFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const input = {
    label: parsed.data.label,
    fieldKey: parsed.data.fieldKey,
    type: parsed.data.type,
    isRequired: parsed.data.isRequired,
    options: parsed.data.optionsCsv
      ? parsed.data.optionsCsv.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    maxLength: parsed.data.maxLength === "" ? null : (parsed.data.maxLength ?? null),
    sortOrder: parsed.data.sortOrder,
  };

  try {
    if (fieldId) {
      await adminUpdateCustomizationField(productId, fieldId, input);
    } else {
      await adminAddCustomizationField(productId, input);
    }
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { success: false, message: "That field key is already used on this product." };
    }
    return { success: false, message: toUserMessage(error, "Could not save the field.") };
  }
}

export async function deleteCustomizationFieldAction(
  fieldId: string,
  productId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteCustomizationField(productId, fieldId);
    revalidatePath(`/admin/products/${productId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the field.") };
  }
}

export async function addBundleItemAction(
  bundleId: string,
  componentId: string,
  quantity: number,
  variantId: string | null = null,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminAddBundleItem(bundleId, componentId, quantity, variantId);
    revalidatePath(`/admin/products/${bundleId}`);
    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { success: false, message: "That product is already in this bundle." };
    }
    return { success: false, message: toUserMessage(error, "Could not add the component.") };
  }
}

export async function deleteBundleItemAction(
  bundleItemId: string,
  bundleId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteBundleItem(bundleId, bundleItemId);
    revalidatePath(`/admin/products/${bundleId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not remove the component.") };
  }
}

export async function searchProductsForBundleAction(search: string, excludeId: string) {
  await requireAdmin();
  if (!search.trim()) return [];
  return adminSearchProductsForBundle(search.trim().slice(0, 100), excludeId);
}
