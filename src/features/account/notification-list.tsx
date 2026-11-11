"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, CreditCard, MessageCircleQuestion, Package, RefreshCcw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDate } from "@/lib/utils";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/server/actions/notification.actions";
import type { MyNotification } from "@/server/services/notification.service";

const ICONS: Record<string, typeof Bell> = { ORDER: Package, PAYMENT: CreditCard, REFUND: RefreshCcw, REVIEW: Star, QUESTION: MessageCircleQuestion };

export function NotificationList({ items, unread }: { items: MyNotification[]; unread: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function markAll() {
    startTransition(async () => {
      await markAllNotificationsReadAction();
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">{unread > 0 ? `${unread} unread` : "You are all caught up"}</p>
        {unread > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={markAll} disabled={pending}>
            Mark all as read
          </Button>
        )}
      </div>
      <ul className="space-y-2">
        {items.map((n) => {
          const Icon = ICONS[n.type] ?? Bell;
          const content = (
            <>
              <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", n.read ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary")}>
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm", n.read ? "text-foreground" : "font-semibold text-foreground")}>{n.title}</span>
                {n.body && <span className="block text-sm text-muted-foreground">{n.body}</span>}
                <span className="block text-xs text-muted-foreground">{formatDate(n.createdAt)}</span>
              </span>
              {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
            </>
          );
          const base = cn("flex items-start gap-3 rounded-xl border p-4", n.read ? "border-border/60 bg-card" : "border-primary/30 bg-primary/5");
          return (
            <li key={n.id}>
              {n.href ? (
                <Link
                  href={n.href}
                  className={cn(base, "hover:bg-secondary/50")}
                  onClick={() => {
                    if (!n.read) void markNotificationReadAction(n.id);
                  }}
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  className={cn(base, "w-full text-left")}
                  onClick={() => {
                    if (!n.read) startTransition(async () => { await markNotificationReadAction(n.id); router.refresh(); });
                  }}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
