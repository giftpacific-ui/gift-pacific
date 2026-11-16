"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin/seo", label: "Overview", exact: true },
  { href: "/admin/seo/settings", label: "Global settings" },
  { href: "/admin/seo/pages", label: "Page SEO" },
  { href: "/admin/seo/products", label: "Products" },
  { href: "/admin/seo/categories", label: "Categories" },
  { href: "/admin/seo/boxes", label: "Gift boxes" },
  { href: "/admin/seo/static-pages", label: "Static pages" },
  { href: "/admin/seo/redirects", label: "Redirects" },
  { href: "/admin/seo/technical", label: "Sitemap & robots" },
];

export function SeoNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="SEO sections" className="-mx-1 mb-6 overflow-x-auto pb-1">
      <ul className="flex min-w-max gap-1 px-1">
        {TABS.map((t) => {
          const active = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={cn("block rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors", active ? "bg-primary text-primary-foreground" : "hover:bg-secondary")}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
