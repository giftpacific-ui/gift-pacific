import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { validateSlotRules } from "@/lib/combo";

/**
 * Selection groups ("slots") and the products allowed in them, for CUSTOMIZABLE combos.
 * Everything a customer can pick is defined here; the storefront never invents options.
 */
export type SlotInput = { label: string; helpText?: string | null; minSelect: number; maxSelect: number; maxPerOption: number; sortOrder?: number; source?: "MANUAL" | "CATALOG" | "BOXES"; categoryId?: string | null };

async function loadCustomizableCombo(comboId: string) {
  const combo = await prisma.product.findUnique({
    where: { id: comboId },
    select: { id: true, kind: true, comboMode: true, comboPricing: true, status: true },
  });
  if (!combo) throw new UserFacingError("Combo not found.");
  if (combo.kind !== "COMBO" || combo.comboMode !== "CUSTOMIZABLE") {
    throw new UserFacingError("Selection groups only apply to customizable combos.");
  }
  return combo;
}

export async function adminListComboSlots(comboId: string) {
  const slots = await prisma.comboSlot.findMany({
    where: { comboId },
    orderBy: { sortOrder: "asc" },
    include: {
      options: {
        orderBy: { sortOrder: "asc" },
        include: { product: { select: { id: true, name: true, price: true, status: true, type: true } }, variant: { select: { id: true, name: true } } },
      },
    },
  });
  return slots.map((s) => ({
    id: s.id,
    label: s.label,
    helpText: s.helpText,
    minSelect: s.minSelect,
    maxSelect: s.maxSelect,
    maxPerOption: s.maxPerOption,
    sortOrder: s.sortOrder,
    source: s.source,
    categoryId: s.categoryId,
    options: s.options.map((o) => ({
      id: o.id,
      productId: o.productId,
      productName: o.product.name,
      productStatus: o.product.status,
      variantId: o.variantId,
      variantName: o.variant?.name ?? null,
      priceDelta: Number(o.priceDelta),
    })),
  }));
}

export async function adminSaveComboSlot(comboId: string, slotId: string | null, input: SlotInput) {
  await loadCustomizableCombo(comboId);
  const error = validateSlotRules(input);
  if (error) throw new UserFacingError(error);
  const source = input.source ?? "MANUAL";
  const combo = await loadCustomizableCombo(comboId);
  if (source === "CATALOG" && combo.comboPricing !== "COMPONENT_SUM") {
    // With a fixed combo price every free-choice item would cost the same: refuse, never silently invent a price rule.
    throw new UserFacingError("Free-choice (any product) groups need the combo price set to “Sum of component prices”. Change the pricing on the combo first.");
  }
  if (!["MANUAL", "CATALOG", "BOXES"].includes(source)) throw new UserFacingError("Unknown group source.");
  const categoryId = source === "CATALOG" && input.categoryId ? String(input.categoryId) : null;
  if (categoryId && !(await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }))) throw new UserFacingError("That category was not found.");
  const data = {
    source,
    categoryId,
    label: input.label.trim(),
    helpText: input.helpText?.trim() || null,
    minSelect: input.minSelect,
    maxSelect: input.maxSelect,
    maxPerOption: input.maxPerOption,
    sortOrder: input.sortOrder ?? 0,
  };
  if (!slotId) return prisma.comboSlot.create({ data: { comboId, ...data } });
  const updated = await prisma.comboSlot.updateMany({ where: { id: slotId, comboId }, data });
  if (updated.count !== 1) throw new UserFacingError("Selection group not found.");
  return prisma.comboSlot.findUniqueOrThrow({ where: { id: slotId } });
}

export async function adminDeleteComboSlot(comboId: string, slotId: string) {
  const combo = await loadCustomizableCombo(comboId);
  await prisma.$transaction(async (tx) => {
    if (combo.status === "ACTIVE" && (await tx.comboSlot.count({ where: { comboId } })) <= 1) {
      throw new UserFacingError("An active combo needs at least one selection group. Set it to Draft first.");
    }
    const deleted = await tx.comboSlot.deleteMany({ where: { id: slotId, comboId } });
    if (deleted.count !== 1) throw new UserFacingError("Selection group not found.");
  });
}

export async function adminAddComboOption(
  comboId: string,
  slotId: string,
  input: { productId: string; variantId?: string | null; priceDelta?: number },
) {
  await loadCustomizableCombo(comboId);
  const slot = await prisma.comboSlot.findFirst({ where: { id: slotId, comboId }, select: { id: true } });
  if (!slot) throw new UserFacingError("Selection group not found.");
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, kind: true, type: true, variants: { select: { id: true } } },
  });
  if (!product) throw new UserFacingError("Product not found.");
  if (product.kind === "COMBO") throw new UserFacingError("A combo cannot contain another combo.");
  const variantId = input.variantId || null;
  if (product.type === "VARIANT") {
    if (!variantId || !product.variants.some((v) => v.id === variantId)) {
      throw new UserFacingError("Choose which option of that product customers can pick.");
    }
  } else if (variantId) {
    throw new UserFacingError("That product has no options.");
  }
  const priceDelta = input.priceDelta ?? 0;
  if (!Number.isFinite(priceDelta) || priceDelta < 0) throw new UserFacingError("The surcharge cannot be negative.");
  const duplicate = await prisma.comboSlotOption.findFirst({ where: { slotId, productId: input.productId, variantId } });
  if (duplicate) throw new UserFacingError("That product is already in this group.");
  const count = await prisma.comboSlotOption.count({ where: { slotId } });
  return prisma.comboSlotOption.create({ data: { slotId, productId: input.productId, variantId, priceDelta, sortOrder: count } });
}

export async function adminDeleteComboOption(comboId: string, slotId: string, optionId: string) {
  const combo = await loadCustomizableCombo(comboId);
  await prisma.$transaction(async (tx) => {
    const slot = await tx.comboSlot.findFirst({ where: { id: slotId, comboId }, select: { id: true } });
    if (!slot) throw new UserFacingError("Selection group not found.");
    if (combo.status === "ACTIVE" && (await tx.comboSlotOption.count({ where: { slotId } })) <= 1) {
      throw new UserFacingError("An active combo's group needs at least one product. Set it to Draft first.");
    }
    const deleted = await tx.comboSlotOption.deleteMany({ where: { id: optionId, slotId } });
    if (deleted.count !== 1) throw new UserFacingError("Product not found in this group.");
  });
}
