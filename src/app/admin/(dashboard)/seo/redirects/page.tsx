import type { Metadata } from "next";
import { adminListRedirects } from "@/server/services/admin-cms.service";
import { RedirectManager } from "@/features/admin/seo/redirect-manager";
import { SeoListControls, firstParam, pageParam } from "@/features/admin/seo/seo-pager";

export const metadata: Metadata = { title: "Redirects · Admin" };

export default async function RedirectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const status = firstParam(sp.status) === "inactive" ? "inactive" : firstParam(sp.status) === "active" ? "active" : "all";
  const list = await adminListRedirects({ q, status, page: pageParam(sp.page) });
  return (
    <div className="space-y-4">
      <RedirectManager rows={list.items.map((r) => ({ id: r.id, fromPath: r.fromPath, toPath: r.toPath, statusCode: r.statusCode, isActive: r.isActive }))} />
      <SeoListControls action="/admin/seo/redirects" q={q} filter={status} filters={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} page={list.page} pageCount={list.pageCount} total={list.total} />
      <p className="text-xs text-muted-foreground">Renamed product and category URLs already redirect automatically (301) to the current address; those are not listed here.</p>
    </div>
  );
}
