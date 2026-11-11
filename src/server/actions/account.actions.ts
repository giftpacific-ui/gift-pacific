"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth/current-user";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { addressSchema, type AddressInput } from "@/lib/validations/checkout";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/validations/auth";
import {
  createAddress,
  deleteAddress as deleteAddressService,
  setDefaultAddress as setDefaultAddressService,
  updateAddress,
} from "@/server/services/address.service";
import { updateProfile as updateProfileService } from "@/server/services/account.service";
import { setInitialPassword, unlinkProvider } from "@/server/services/connected-accounts.service";
import { toUserMessage } from "@/lib/errors";

export type ActionResult =
  | { success: true }
  | { success: false; message: string; fieldErrors?: Record<string, string[]> };

export async function updateProfileAction(input: {
  name: string;
  phone?: string;
}): Promise<ActionResult> {
  if (!input.name || input.name.trim().length < 2) {
    return { success: false, message: "Name must be at least 2 characters." };
  }
  await updateProfileService({ name: input.name.trim(), phone: input.phone });
  revalidatePath("/account/settings");
  return { success: true };
}

export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ActionResult> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "Invalid input.", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const user = await requireUser();
  if (!user.passwordHash) {
    return {
      success: false,
      message: "This account signs in with Google or Facebook and has no password to change.",
    };
  }
  const isValid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!isValid) {
    return { success: false, message: "Current password is incorrect." };
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  return { success: true };
}

export async function addAddressAction(
  input: AddressInput & { isDefault?: boolean },
): Promise<ActionResult> {
  const parsed = addressSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "Please check the form.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  await createAddress({ ...parsed.data, isDefault: input.isDefault });
  revalidatePath("/account/settings");
  return { success: true };
}

export async function updateAddressAction(
  addressId: string,
  input: AddressInput & { isDefault?: boolean },
): Promise<ActionResult> {
  const parsed = addressSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "Please check the form.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  await updateAddress(addressId, { ...parsed.data, isDefault: input.isDefault });
  revalidatePath("/account/settings");
  return { success: true };
}

export async function deleteAddressAction(addressId: string): Promise<ActionResult> {
  await deleteAddressService(addressId);
  revalidatePath("/account/settings");
  return { success: true };
}

export async function setDefaultAddressAction(addressId: string): Promise<ActionResult> {
  await setDefaultAddressService(addressId);
  revalidatePath("/account/settings");
  return { success: true };
}

export async function unlinkProviderAction(provider: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await unlinkProvider(user.id, String(provider).toUpperCase());
    revalidatePath("/account/settings");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not disconnect that account.") };
  }
}

export async function setInitialPasswordAction(input: { newPassword: string; confirmPassword: string }): Promise<ActionResult> {
  const user = await requireUser();
  const pw = String(input?.newPassword ?? "");
  if (pw.length < 8 || pw.length > 200) return { success: false, message: "Password must be at least 8 characters." };
  if (pw !== input.confirmPassword) return { success: false, message: "Passwords do not match." };
  try {
    await setInitialPassword(user.id, await hashPassword(pw));
    revalidatePath("/account/settings");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not set the password.") };
  }
}
