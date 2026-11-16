import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Search + filter + pagination controls driven by the URL (GET form), so lists stay shareable and need no client state. */
export function SeoListControls({
  action, q, filter, filters, page, pageCount, total,
}: { action: string; q: string; filter?: string; filters?: { value: string; label: string }[]; page: number; pageCount: number; total: number }) {
  const href = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (filter && filter !== "all") sp.set("filter", filter);
    if (p > 1) sp.set("page", String(p));
    const s = sp.toString();
    return s ? `${action}?${s}` : action;
  };
  return (
    <div className="space-y-3">
      <form action={action} method="get" className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1"><label htmlFor="seo-q" className="sr-only">Search</label>
          <input id="seo-q" name="q" defaultValue={q} placeholder="Search by name or slug" className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm" /></div>
        {filters && (
          <div><label htmlFor="seo-filter" className="sr-only">Filter</label>
            <select id="seo-filter" name="filter" defaultValue={filter ?? "all"} className="h-10 rounded-lg border border-input bg-card px-3 text-sm">
              {filters.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></div>
        )}
        <Button type="submit" size="sm" className="h-10">Apply</Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{total} result{total === 1 ? "" : "s"} · page {page} of {pageCount}</span>
        <span className="flex gap-2">
          {page > 1 ? <Button asChild size="sm" variant="outline"><Link href={href(page - 1)}>Previous</Link></Button> : null}
          {page < pageCount ? <Button asChild size="sm" variant="outline"><Link href={href(page + 1)}>Next</Link></Button> : null}
        </span>
      </div>
    </div>
  );
}

export const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
export const pageParam = (v: string | string[] | undefined) => Math.max(1, Number.parseInt(firstParam(v) || "1", 10) || 1);
