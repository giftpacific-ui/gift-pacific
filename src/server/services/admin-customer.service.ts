import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

export async function adminListCustomers(params: { search?: string; page?: number; pageSize?: number }) {
  const { search, page = 1, pageSize = 20 } = params;
  const where: Prisma.UserWhereInput = {
    role: "CUSTOMER",
    ...(search
      ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { email: { contains: search, mode: "insensitive" } }] }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // Defence in depth: the password hash is never needed by an admin view.
      omit: { passwordHash: true },
      include: { _count: { select: { orders: true } } },
    }),
    prisma.user.count({ where }),
  ]);

  return { items, total, page, pageCount: Math.ceil(total / pageSize) };
}

export async function adminGetCustomerById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    omit: { passwordHash: true },
    include: {
      orders: { orderBy: { createdAt: "desc" }, include: { items: true } },
      addresses: true,
    },
  });
  if (!user) return null;

  const totalSpent = user.orders
    .filter((o) => o.paymentStatus === "PAID")
    .reduce((sum, o) => sum + Number(o.total), 0);

  return { user, totalSpent };
}

export async function adminToggleCustomerActive(userId: string, isActive: boolean) {
  // Guard against a crafted request targeting an ADMIN account — this
  // action is for customer management only, never for disabling other
  // admins.
  return prisma.user.updateMany({
    where: { id: userId, role: "CUSTOMER" },
    data: { isActive },
  });
}
