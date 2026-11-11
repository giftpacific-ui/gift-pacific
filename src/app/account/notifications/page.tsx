import type { Metadata } from "next";
import Link from "next/link";
import { getMyNotifications } from "@/server/services/notification.service";
import { NotificationList } from "@/features/account/notification-list";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  const pageNo = Number.parseInt(page ?? "1", 10);
  const { items, unread, pageCount } = await getMyNotifications(Number.isInteger(pageNo) && pageNo > 0 ? pageNo : 1);
  const current = Number.isInteger(pageNo) && pageNo > 0 ? pageNo : 1;

  return (
    <div className="space-y-4">
      <h1 className="font-heading text-2xl">Notifications</h1>
      {items.length === 0 ? (
        <EmptyState title="No notifications yet" description="Updates about your orders, payments, reviews and questions will appear here." />
      ) : (
        <>
          <NotificationList items={items} unread={unread} />
          {pageCount > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
              {current > 1 ? <Link className="text-primary hover:underline" href={`/account/notifications?page=${current - 1}`}>← Newer</Link> : <span />}
              {current < pageCount ? <Link className="text-primary hover:underline" href={`/account/notifications?page=${current + 1}`}>Older →</Link> : <span />}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
