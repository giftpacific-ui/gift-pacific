import { ITEM_INTERNAL_FIELDS, ORDER_INTERNAL_FIELDS, omitFields } from "@/lib/order-visibility";
import "server-only";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth/current-user";

export async function getAccountOverview() {
  const user = await requireUser();

  const [totalOrders, recentOrders, wishlistCount, statusGroups, unreadNotifications, addresses] = await Promise.all([
    prisma.order.count({ where: { userId: user.id } }),
    prisma.order.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      // Customer-facing: keep staff notes, tokens, courier bookkeeping and
      // stock bookkeeping out of anything rendered for the account owner.
      omit: {
        adminNote: true,
        confirmationToken: true,
        courierProvider: true,
        courierConsignmentId: true,
        courierBookingStatus: true,
        courierBookingStartedAt: true,
        courierBookedAt: true,
        courierLastStatus: true,
        courierLastEventAt: true,
        courierLastError: true,
        ...omitFields(ORDER_INTERNAL_FIELDS),
      },
      include: { items: { omit: omitFields(ITEM_INTERNAL_FIELDS) } },
    }),
    prisma.wishlistItem.count({ where: { wishlist: { userId: user.id } } }),
    prisma.order.groupBy({ by: ["status"], where: { userId: user.id }, _count: { _all: true } }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    prisma.address.findMany({ where: { userId: user.id }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }], take: 1, select: { fullName: true, line1: true, city: true, isDefault: true } }),
  ]);

  const count = (...statuses: string[]) => statusGroups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
  const orderSummary = {
    // Waiting for us: placed/confirmed/being prepared.
    preparing: count("PENDING", "CONFIRMED", "PROCESSING"),
    onTheWay: count("SHIPPED", "OUT_FOR_DELIVERY"),
    delivered: count("DELIVERED"),
    needsAttention: count("FAILED_DELIVERY", "REFUND_REQUESTED"),
  };
  const addressCount = await prisma.address.count({ where: { userId: user.id } });

  return { user, totalOrders, recentOrders, wishlistCount, orderSummary, unreadNotifications, addressCount, mainAddress: addresses[0] ?? null };
}

export async function updateProfile(input: { name: string; phone?: string | null }) {
  const user = await requireUser();
  return prisma.user.update({
    where: { id: user.id },
    data: { name: input.name, phone: input.phone || null },
  });
}
