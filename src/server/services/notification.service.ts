import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import type { NotificationType } from "@/lib/notification-rules";

type Db = Prisma.TransactionClient | typeof prisma;

export type NotifyInput = {
  userId: string | null | undefined;
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Site-relative link only (an order or product page). */
  href?: string | null;
  dedupeKey: string;
};

/**
 * Creates one in-app notification. Safe to call inside a transaction: `skipDuplicates` is ON CONFLICT DO NOTHING on
 * (userId, dedupeKey), so a repeated trigger never creates a second row and never aborts the surrounding transaction.
 * Guest orders (no userId) simply have no notification.
 */
export async function notifyUser(db: Db, input: NotifyInput): Promise<void> {
  if (!input.userId) return;
  const href = input.href && input.href.startsWith("/") && !input.href.startsWith("//") ? input.href : null;
  await db.notification.createMany({
    data: [{ userId: input.userId, type: input.type, title: input.title.slice(0, 120), body: input.body?.slice(0, 300) ?? null, href, dedupeKey: input.dedupeKey.slice(0, 160) }],
    skipDuplicates: true,
  });
}

export type MyNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: Date;
};

const PAGE_SIZE = 30;

/** The signed-in customer's own notifications, newest first. Ownership is the WHERE clause; no id comes from the client. */
export async function getMyNotifications(page = 1): Promise<{ items: MyNotification[]; unread: number; pageCount: number }> {
  const session = await getSession();
  if (!session) return { items: [], unread: 0, pageCount: 0 };
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, type: true, title: true, body: true, href: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId: session.sub } }),
    prisma.notification.count({ where: { userId: session.sub, readAt: null } }),
  ]);
  return {
    items: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, href: n.href, read: n.readAt !== null, createdAt: n.createdAt })),
    unread,
    pageCount: Math.ceil(total / PAGE_SIZE),
  };
}

export async function getMyUnreadNotificationCount(): Promise<number> {
  const session = await getSession();
  if (!session) return 0;
  return prisma.notification.count({ where: { userId: session.sub, readAt: null } });
}

export async function markMyNotificationRead(id: string): Promise<void> {
  const session = await getSession();
  if (!session || typeof id !== "string") return;
  await prisma.notification.updateMany({ where: { id, userId: session.sub, readAt: null }, data: { readAt: new Date() } });
}

export async function markAllMyNotificationsRead(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await prisma.notification.updateMany({ where: { userId: session.sub, readAt: null }, data: { readAt: new Date() } });
}
