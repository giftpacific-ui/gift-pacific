"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import {
  adminAddComboOption,
  adminDeleteComboOption,
  adminDeleteComboSlot,
  adminSaveComboSlot,
  type SlotInput,
} from "@/server/services/admin-combo.service";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

const refresh = (comboId: string) => {
  revalidatePath(`/admin/products/${comboId}`);
  revalidatePath("/shop");
};

export async function saveComboSlotAction(
  comboId: string,
  slotId: string | null,
  input: SlotInput,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminSaveComboSlot(comboId, slotId, {
      label: String(input.label ?? ""),
      helpText: input.helpText ? String(input.helpText) : null,
      minSelect: Number(input.minSelect),
      maxSelect: Number(input.maxSelect),
      maxPerOption: Number(input.maxPerOption),
      sortOrder: input.sortOrder === undefined ? undefined : Number(input.sortOrder),
      source: input.source === "CATALOG" || input.source === "BOXES" ? input.source : "MANUAL",
      categoryId: input.categoryId ? String(input.categoryId) : null,
    });
    refresh(comboId);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the selection group.") };
  }
}

export async function deleteComboSlotAction(comboId: string, slotId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteComboSlot(comboId, slotId);
    refresh(comboId);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the selection group.") };
  }
}

export async function addComboOptionAction(
  comboId: string,
  slotId: string,
  productId: string,
  variantId: string | null,
  priceDelta: number,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminAddComboOption(comboId, slotId, { productId, variantId, priceDelta });
    refresh(comboId);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not add the product.") };
  }
}

export async function deleteComboOptionAction(
  comboId: string,
  slotId: string,
  optionId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteComboOption(comboId, slotId, optionId);
    refresh(comboId);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not remove the product.") };
  }
}
