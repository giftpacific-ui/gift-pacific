import type { Metadata } from "next";
import Link from "next/link";
import { adminListContactMessages } from "@/server/services/admin-contact.service";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Contact Messages · Admin" };

export default async function AdminContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const { items, unreadCount, pageCount } = await adminListContactMessages({ page });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Contact Messages</h1>
        {unreadCount > 0 && <Badge variant="default">{unreadCount} unread</Badge>}
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="No messages yet"
          description="Messages submitted through the Contact Us page will show up here."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-border/70 text-left text-muted-foreground">
              <tr>
                <th className="p-3" />
                <th className="p-3">From</th>
                <th className="p-3">Subject</th>
                <th className="p-3">Received</th>
              </tr>
            </thead>
            <tbody>
              {items.map((message) => (
                <tr
                  key={message.id}
                  className="border-b border-border/50 last:border-0 hover:bg-secondary/50"
                >
                  <td className="p-3">
                    {!message.isRead && <span className="block size-2 rounded-full bg-primary" />}
                  </td>
                  <td className="p-3">
                    <Link
                      href={`/admin/contacts/${message.id}`}
                      className={message.isRead ? "text-foreground" : "font-semibold"}
                    >
                      {message.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{message.email}</p>
                  </td>
                  <td className="p-3">
                    <Link href={`/admin/contacts/${message.id}`} className="hover:underline">
                      {message.subject}
                    </Link>
                  </td>
                  <td className="p-3 text-muted-foreground">{formatDate(message.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pageCount={pageCount} basePath="/admin/contacts" searchParams={params} />
    </div>
  );
}
