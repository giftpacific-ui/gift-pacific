"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bell, LayoutDashboard, MapPin, Package, Heart, Settings, LogOut, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { logoutUser } from "@/server/actions/auth.actions";

const links = [
  { href: "/account", label: "Dashboard", icon: LayoutDashboard, match: (p: string) => p === "/account" },
  { href: "/account/orders", label: "My Orders", icon: Package, match: (p: string) => p.startsWith("/account/orders") },
  { href: "/account/notifications", label: "Notifications", icon: Bell, match: (p: string) => p.startsWith("/account/notifications") },
  { href: "/account/wishlist", label: "Wishlist", icon: Heart, match: (p: string) => p.startsWith("/account/wishlist") },
  { href: "/account/reviews", label: "My reviews", icon: Star, match: (p: string) => p.startsWith("/account/reviews") },
  { href: "/account/settings?tab=addresses", label: "Addresses", icon: MapPin, match: (p: string, tab: string | null) => p.startsWith("/account/settings") && tab === "addresses" },
  { href: "/account/settings", label: "Settings", icon: Settings, match: (p: string, tab: string | null) => p.startsWith("/account/settings") && tab !== "addresses" },
];

export function AccountSidebar({ unreadCount = 0 }: { unreadCount?: number }) {
  const pathname = usePathname() ?? "";
  const tab = useSearchParams().get("tab");
  const router = useRouter();

  return (
    <aside className="w-full shrink-0 lg:w-56">
      <nav aria-label="Account" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {links.map((link) => {
          const isActive = link.match(pathname, tab);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm whitespace-nowrap",
                isActive ? "bg-primary text-primary-foreground" : "hover:bg-secondary",
              )}
            >
              <link.icon className="size-4" aria-hidden />
              {link.label}
              {link.href === "/account/notifications" && unreadCount > 0 && (
                <span className="ml-1 rounded-full bg-primary px-1.5 text-[0.65rem] font-semibold text-primary-foreground" aria-label={`${unreadCount} unread`}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={async () => {
            await logoutUser();
            router.push("/");
            router.refresh();
          }}
          className="flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap text-destructive hover:bg-destructive/10"
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </button>
      </nav>
    </aside>
  );
}
