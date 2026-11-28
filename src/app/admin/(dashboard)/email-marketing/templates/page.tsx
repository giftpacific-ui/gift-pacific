import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { requireAdmin } from "@/lib/auth/current-user";
import {
  adminGetEmailTemplateStats,
  adminListEmailTemplates,
  TEMPLATE_STATUSES,
} from "@/server/services/email-template-designer.service";
import { TEMPLATE_CATEGORIES } from "@/lib/email/template-rules";
import { Pagination } from "@/components/shared/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TemplatesTable } from "@/features/admin/email-templates/templates-table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Templates · Email marketing · Admin",
};
const BASE = "/admin/email-marketing/templates";

export default async function EmailTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin(); // the layout redirects too, but a page must not rely on that to protect its own data
  const sp = await searchParams;
  const [stats, list] = await Promise.all([
    adminGetEmailTemplateStats(admin.id),
    adminListEmailTemplates(admin.id, {
      q: sp.q,
      category: sp.category,
      status: sp.status,
      page: sp.page,
    }),
  ]);
  const href = (over: { status?: string | null }) => {
    const p = new URLSearchParams();
    const status = over.status === undefined ? list.status : over.status;
    if (status) p.set("status", status);
    if (list.category) p.set("category", list.category);
    if (list.q) p.set("q", list.q);
    const qs = p.toString();
    return `${BASE}${qs ? `?${qs}` : ""}`;
  };
  const cards = [
    { label: "Total templates", value: stats.total },
    { label: "Active", value: stats.active },
    { label: "Draft", value: stats.draft },
    { label: "Archived", value: stats.archived },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Email templates</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Design promotional e-mails from blocks. Active templates are ready
            for campaigns; drafts are not. Every template carries the
            unsubscribe link, and campaigns keep their own copy of a template,
            so editing one never changes a campaign already created.
          </p>
        </div>
        <Button asChild>
          <Link href={`${BASE}/new`}>
            <Plus /> Create template
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="text-xs uppercase text-muted-foreground">
                {c.label}
              </div>
              <div className="text-2xl font-semibold">
                {c.value.toLocaleString("en-US")}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <nav
        aria-label="Status filters"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {[null, ...TEMPLATE_STATUSES].map((s) => (
          <Link
            key={s ?? "all"}
            href={href({ status: s })}
            aria-current={list.status === s ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-full border px-3 py-1.5 text-sm",
              list.status === s
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:bg-secondary",
            )}
          >
            {s ? s.charAt(0).toUpperCase() + s.slice(1) : "All"}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-center gap-2">
        {list.status && (
          <input type="hidden" name="status" value={list.status} />
        )}
        <Input
          name="q"
          defaultValue={list.q}
          maxLength={100}
          placeholder="Search template name"
          className="w-full sm:w-72"
          aria-label="Search templates"
        />
        <select
          name="category"
          defaultValue={list.category ?? ""}
          aria-label="Category"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All categories</option>
          {TEMPLATE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0) + c.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline">
          <Search /> Search
        </Button>
        {(list.q || list.category) && (
          <Button asChild variant="ghost">
            <Link
              href={
                href({}).split("?")[0] +
                (list.status ? `?status=${list.status}` : "")
              }
            >
              Clear
            </Link>
          </Button>
        )}
      </form>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {list.total.toLocaleString("en-US")} template
        {list.total === 1 ? "" : "s"}
      </p>
      <TemplatesTable rows={list.rows} />
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        basePath={BASE}
        searchParams={{
          status: list.status ?? undefined,
          category: list.category ?? undefined,
          q: list.q || undefined,
        }}
      />
    </div>
  );
}
