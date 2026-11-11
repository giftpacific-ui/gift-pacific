import "server-only";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth/current-user";
import type { AddressInput } from "@/lib/validations/checkout";

export async function getAddressesForCurrentUser() {
  const user = await requireUser();
  return prisma.address.findMany({
    where: { userId: user.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

export async function createAddress(input: AddressInput & { isDefault?: boolean }) {
  const user = await requireUser();

  if (input.isDefault) {
    await prisma.address.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
  }

  return prisma.address.create({
    data: {
      userId: user.id,
      fullName: input.fullName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2 || null,
      city: input.city,
      state: input.state || null,
      postalCode: input.postalCode || null,
      country: input.country,
      isDefault: input.isDefault ?? false,
    },
  });
}

export async function updateAddress(
  addressId: string,
  input: AddressInput & { isDefault?: boolean },
) {
  const user = await requireUser();
  const existing = await prisma.address.findFirst({ where: { id: addressId, userId: user.id } });
  if (!existing) throw new Error("Address not found.");

  if (input.isDefault) {
    await prisma.address.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
  }

  return prisma.address.update({
    where: { id: addressId },
    data: {
      fullName: input.fullName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2 || null,
      city: input.city,
      state: input.state || null,
      postalCode: input.postalCode || null,
      country: input.country,
      isDefault: input.isDefault ?? existing.isDefault,
    },
  });
}

export async function deleteAddress(addressId: string) {
  const user = await requireUser();
  await prisma.address.deleteMany({ where: { id: addressId, userId: user.id } });
}

export async function setDefaultAddress(addressId: string) {
  const user = await requireUser();
  // Verify ownership first: otherwise an unknown/foreign id would clear the
  // user's current default and then set nothing.
  const owned = await prisma.address.findFirst({ where: { id: addressId, userId: user.id }, select: { id: true } });
  if (!owned) throw new Error("Address not found.");
  await prisma.$transaction([
    prisma.address.updateMany({ where: { userId: user.id }, data: { isDefault: false } }),
    prisma.address.updateMany({
      where: { id: addressId, userId: user.id },
      data: { isDefault: true },
    }),
  ]);
}
