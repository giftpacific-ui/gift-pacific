import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SYSTEM_PAGES } from "@/lib/seo-pages";
import { adminListStaticPages, adminSystemStaticPages } from "@/server/services/admin-cms.service";
import { SeoListControls, firstParam, pageParam } from "@/features/admin/seo/seo-pager";

export const metadata: Metadata = { title: "Static pages · Admin" };

export default async function StaticPagesAdmin({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const [list, systemRows] = await Promise.all([adminListStaticPages({ q, page: pageParam(sp.page) }), adminSystemStaticPages()]);
  const sysByKey = new Map(systemRows.map((r) => [r.systemKey!, r]));
  const normal = list.items.filter((p) => !p.systemKey);
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="font-heading text-lg">Built-in pages</h2>
        <p className="text-sm text-muted-foreground">These pages keep their current content and URLs. Publish replacement content here to edit them without code; remove it to go back to the built-in text.</p>
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
          {SYSTEM_PAGES.filter((p) => p.cms).map((p) => {
            const row = sysByKey.get(p.key);
            return (
              <li key={p.key} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div><p className="font-medium">{p.label}</p><p className="text-xs text-muted-foreground">{p.path}</p></div>
                <div className="flex items-center gap-2">
                  <Badge variant={row?.isPublished ? "success" : "secondary"}>{row ? (row.isPublished ? "Admin content live" : "Draft — built-in content shown") : "Built-in content"}</Badge>
                  <Button asChild size="sm" variant="outline"><Link href={row ? `/admin/seo/static-pages/${row.id}` : `/admin/seo/static-pages/new?system=${p.key}`}>{row ? "Edit" : "Customize"}</Link></Button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="font-heading text-lg">Custom pages</h2><Button asChild size="sm"><Link href="/admin/seo/static-pages/new">New page</Link></Button></div>
        <SeoListControls action="/admin/seo/static-pages" q={q} page={list.page} pageCount={list.pageCount} total={list.total} />
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
          {normal.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0"><p className="truncate font-medium">{p.title}</p><p className="truncate text-xs text-muted-foreground">/pages/{p.slug} · order {p.sortOrder}{p.showInFooter ? " · footer" : ""}</p></div>
              <div className="flex items-center gap-2">
                {p.noIndex && <Badge variant="destructive">noindex</Badge>}
                <Badge variant={p.isPublished ? "success" : "secondary"}>{p.isPublished ? "Published" : "Draft"}</Badge>
                <Button asChild size="sm" variant="outline"><Link href={`/admin/seo/static-pages/${p.id}`}>Edit</Link></Button>
              </div>
            </li>
          ))}
          {normal.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">No custom pages yet.</li>}
        </ul>
      </section>
    </div>
  );
}
