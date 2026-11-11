"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, LogOut, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { logoutAdmin } from "@/server/actions/auth.actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { siteConfig } from "@/config/site";
import { ADMIN_NAV, isAdminLinkActive } from "@/config/admin-nav";

/** Groups that contain the current page start open; the rest can be toggled. */
function AdminNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <nav aria-label="Admin navigation" className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
      {ADMIN_NAV.map((group) => {
        const hasActive = group.items.some((i) => isAdminLinkActive(pathname, i.href));
        const single = group.items.length === 1 && group.id !== "catalog";
        const isCollapsed = !single && !hasActive && collapsed[group.id] === true;
        return (
          <div key={group.id}>
            {!single && (
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-controls={`admin-nav-${group.id}`}
                onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !isCollapsed }))}
                className="flex w-full items-center justify-between px-3 pb-1 text-[0.68rem] font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground"
              >
                <span className="truncate">{group.label}</span>
                <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", isCollapsed && "-rotate-90")} aria-hidden />
              </button>
            )}
            <ul id={`admin-nav-${group.id}`} hidden={isCollapsed} className="space-y-0.5">
              {group.items.map((link) => {
                const active = isAdminLinkActive(pathname, link.href);
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      title={link.label}
                      className={cn(
                        "flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors sm:py-2",
                        active ? "bg-primary text-primary-foreground" : "hover:bg-secondary",
                      )}
                    >
                      <link.icon className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{link.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function AdminSignOutButton() {
  const router = useRouter();
  return (
    <div className="shrink-0 border-t border-border/70 pt-3">
      <button
        type="button"
        onClick={async () => {
          await logoutAdmin();
          router.push("/admin/login");
          router.refresh();
        }}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 sm:py-2"
      >
        <LogOut className="size-4 shrink-0" aria-hidden />
        Sign out
      </button>
    </div>
  );
}

function StoreBrand({ storeName, logoUrl, size }: { storeName: string; logoUrl?: string | null; size: "lg" | "sm" }) {
  return (
    <Link href="/" className="flex min-w-0 items-center justify-center font-heading text-xl tracking-tight">
      {logoUrl ? (
        <Image src={logoUrl} alt={storeName} width={size === "lg" ? 96 : 80} height={size === "lg" ? 63 : 53} className="w-auto object-contain" priority />
      ) : (
        <span className="truncate">{storeName}</span>
      )}
    </Link>
  );
}

interface AdminSidebarProps {
  storeName?: string;
  logoUrl?: string | null;
}

/** Persistent sidebar at lg and above: fixed header, scrolling route list, fixed sign-out. */
export function AdminSidebar({ storeName = siteConfig.name, logoUrl }: AdminSidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-3 overflow-hidden border-r border-border/70 bg-card p-4 lg:flex print:hidden">
      <div className="shrink-0 border-b border-border/70 pb-3">
        <StoreBrand storeName={storeName || siteConfig.name} logoUrl={logoUrl} size="lg" />
      </div>
      <AdminNavLinks />
      <AdminSignOutButton />
    </aside>
  );
}

/** Sticky top bar + slide-out drawer below lg. */
export function AdminMobileHeader({ storeName = siteConfig.name, logoUrl }: AdminSidebarProps) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border/70 bg-card px-4 lg:hidden print:hidden">
      <StoreBrand storeName={storeName || siteConfig.name} logoUrl={logoUrl} size="sm" />
      <Sheet open={open} onOpenChange={setOpen}>
        <Button type="button" variant="ghost" size="icon" aria-label="Open admin menu" onClick={() => setOpen(true)}>
          <Menu />
        </Button>
        <SheetContent side="left" className="flex h-dvh w-72 max-w-[85vw] flex-col gap-3 overflow-hidden p-4">
          <SheetHeader className="shrink-0">
            <SheetTitle>Admin menu</SheetTitle>
            <SheetDescription className="sr-only">Navigate the admin dashboard</SheetDescription>
          </SheetHeader>
          <AdminNavLinks onNavigate={() => setOpen(false)} />
          <AdminSignOutButton />
        </SheetContent>
      </Sheet>
    </header>
  );
}
