"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import {
  adminDeleteAttribute,
  adminDeleteGroup,
  adminDeleteOption,
  adminSaveAttribute,
  adminSaveGroup,
  adminSaveOption,
  adminSaveProductAttributes,
  type AttributeInput,
  type ProductAttributeEntry,
} from "@/server/services/attribute.service";

type Result = { success: true } | { success: false; message: string };

async function run(fn: () => Promise<void>, fallback: string, paths: string[]): Promise<Result> {
  await requireAdmin();
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, fallback) };
  }
}

const A = ["/admin/attributes"];

export async function saveAttributeGroupAction(id: string | null, input: { name: string; sortOrder?: number; isActive?: boolean }) {
  return run(() => adminSaveGroup(id, input), "Could not save the group.", A);
}
export async function deleteAttributeGroupAction(id: string) {
  return run(() => adminDeleteGroup(id), "Could not delete the group.", A);
}
export async function saveAttributeAction(id: string | null, input: AttributeInput) {
  return run(() => adminSaveAttribute(id, input), "Could not save the attribute.", [...A, "/shop"]);
}
export async function deleteAttributeAction(id: string) {
  return run(() => adminDeleteAttribute(id), "Could not delete the attribute.", [...A, "/shop"]);
}
export async function saveAttributeOptionAction(attributeId: string, optionId: string | null, input: { label: string; sortOrder?: number }) {
  return run(() => adminSaveOption(attributeId, optionId, input), "Could not save the option.", A);
}
export async function deleteAttributeOptionAction(attributeId: string, optionId: string) {
  return run(() => adminDeleteOption(attributeId, optionId), "Could not delete the option.", A);
}

export async function saveProductAttributesAction(productId: string, entries: ProductAttributeEntry[]) {
  return run(() => adminSaveProductAttributes(productId, entries), "Could not save the attributes.", [`/admin/products/${productId}`, "/shop"]);
}
