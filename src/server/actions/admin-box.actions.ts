"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { deleteImageFromCloudinary } from "@/lib/cloudinary/cloudinary";
import { adminDeleteBox, adminMoveBox, adminSaveBox, adminToggleBox } from "@/server/services/box.service";
import type { BoxInput } from "@/lib/validations/box";

type Result = { success: true; id?: string } | { success: false; message: string };
const PATHS = ["/admin/boxes", "/boxes", "/build-your-own-combo"];

async function run(fn: () => Promise<Result | void>, fallback: string): Promise<Result> {
  await requireAdmin();
  try {
    const out = await fn();
    for (const p of PATHS) revalidatePath(p);
    revalidatePath("/boxes/[slug]", "page");
    return out ?? { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, fallback) };
  }
}

/** Replaced/removed images are deleted only AFTER the database save succeeded and only if no other box uses them. */
async function dropAsset(publicId: string | null) {
  if (publicId) await deleteImageFromCloudinary(publicId).catch(() => undefined);
}

export async function saveBoxAction(id: string | null, input: BoxInput) {
  return run(async () => {
    const saved = await adminSaveBox(id, input);
    await dropAsset(saved.orphanedPublicId);
    return { success: true as const, id: saved.id };
  }, "Could not save the box.");
}

export async function deleteBoxAction(id: string) {
  return run(async () => { await dropAsset(await adminDeleteBox(id)); }, "Could not delete the box.");
}

export async function moveBoxAction(id: string, direction: "up" | "down") {
  return run(() => adminMoveBox(id, direction), "Could not reorder the box.");
}

export async function toggleBoxAction(id: string, isActive: boolean) {
  return run(() => adminToggleBox(id, isActive), "Could not update the box.");
}
