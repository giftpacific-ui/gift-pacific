import "server-only";
import { prisma } from "@/lib/db/prisma";

export async function adminListContactMessages(params: { page?: number; pageSize?: number } = {}) {
  const { page = 1, pageSize = 20 } = params;

  const [items, total, unreadCount] = await Promise.all([
    prisma.contactMessage.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contactMessage.count(),
    prisma.contactMessage.count({ where: { isRead: false } }),
  ]);

  return { items, total, unreadCount, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function adminGetContactMessage(id: string) {
  return prisma.contactMessage.findUnique({ where: { id } });
}

export async function adminMarkContactMessageRead(id: string, isRead: boolean) {
  return prisma.contactMessage.update({ where: { id }, data: { isRead } });
}

export async function adminDeleteContactMessage(id: string) {
  return prisma.contactMessage.delete({ where: { id } });
}
