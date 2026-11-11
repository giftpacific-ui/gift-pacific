"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { findAdminNavItem } from "@/config/admin-nav";

const SEGMENT_LABELS: Record<string, string> = {
  new: "New",
  external: "External order",
  invoice: "Invoice",
  channels: "Sales channels",
  edit: "Edit",
  cod: "COD reconciliation",
  bulk: "Bulk booking",
  payments: "Payment reconciliation",
};

/** Admin → Section → … trail derived from the central nav config. Unknown segments (record ids) read "Details". */
export function AdminBreadcrumbs() {
  const pathname = usePathname() ?? "/admin";
  const section = findAdminNavItem(pathname);
  if (!section || section.href === "/admin") return null;

  const tail = pathname === section.href ? [] : pathname.slice(section.href.length + 1).split("/").filter(Boolean);
  const crumbs = [
    { label: "Admin", href: "/admin" },
    { label: section.label, href: section.href },
    ...tail.map((segment, i) => ({
      label: SEGMENT_LABELS[segment] ?? "Details",
      href: `${section.href}/${tail.slice(0, i + 1).join("/")}`,
    })),
  ];

  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground print:hidden">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={crumb.href} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
              {last ? (
                <span aria-current="page" className="text-foreground">{crumb.label}</span>
              ) : (
                <Link href={crumb.href} className="hover:text-foreground">{crumb.label}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
