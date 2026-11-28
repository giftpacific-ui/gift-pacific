import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminGetCampaignStats, adminListCampaigns } from "@/server/services/admin-email-campaign.service";
import { CAMPAIGN_STATUSES } from "@/lib/email/campaign-rules";
import { CAMPAIGN_STATUS_LABEL } from "@/lib/email-campaigns";
import { Pagination } from "@/components/shared/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CampaignsTable } from "@/features/admin/email-campaigns/campaigns-table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Campaigns · Email marketing · Admin" };
// Send now / Continue sending are server actions that run inside this page's function: the Hobby limit declared here bounds them. (A literal, as Next.js requires; equals the request budget in src/lib/email/queue-policy.ts.)
export const maxDuration = 60;
const BASE = "/admin/email-marketing/campaigns";

export default async function EmailCampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin(); // the layout redirects too, but a page must not rely on that to protect its own data
  const sp = await searchParams;
  const [stats, list] = await Promise.all([adminGetCampaignStats(admin.id), adminListCampaigns(admin.id, { q: sp.q, status: sp.status, page: sp.page })]);
  const href = (status: string | null) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (list.q) p.set("q", list.q);
    const qs = p.toString();
    return `${BASE}${qs ? `?${qs}` : ""}`;
  };
  const cards = [
    { label: "Total campaigns", value: stats.total }, { label: "Drafts", value: stats.byStatus.DRAFT }, { label: "Scheduled", value: stats.byStatus.SCHEDULED },
    { label: "Sending", value: stats.byStatus.SENDING }, { label: "Completed", value: stats.byStatus.COMPLETED }, { label: "Cancelled / failed", value: stats.byStatus.CANCELLED + stats.byStatus.FAILED },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Email campaigns</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">Create a campaign from a ready template, prepare its audience of consenting subscribers and send it. Sending starts right away and is delivered by the store&apos;s e-mail worker; unsubscribed and suppressed contacts are never mailed.</p>
        </div>
        <Button asChild><Link href={`${BASE}/new`}><Plus /> Create campaign</Link></Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => <Card key={c.label}><CardContent className="p-4"><div className="text-xs uppercase text-muted-foreground">{c.label}</div><div className="text-2xl font-semibold">{c.value.toLocaleString("en-US")}</div></CardContent></Card>)}
      </div>

      <nav aria-label="Status filters" className="flex gap-2 overflow-x-auto pb-1">
        {[null, ...CAMPAIGN_STATUSES].map((s) => (
          <Link key={s ?? "all"} href={href(s)} aria-current={list.status === s ? "page" : undefined}
            className={cn("whitespace-nowrap rounded-full border px-3 py-1.5 text-sm", list.status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-secondary")}>
            {s ? CAMPAIGN_STATUS_LABEL[s] : "All"}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-center gap-2">
        {list.status && <input type="hidden" name="status" value={list.status} />}
        <Input name="q" defaultValue={list.q} maxLength={100} placeholder="Search campaign name" className="w-full sm:w-72" aria-label="Search campaigns" />
        <Button type="submit" variant="outline"><Search /> Search</Button>
        {list.q && <Button asChild variant="ghost"><Link href={href(list.status)}>Clear</Link></Button>}
      </form>

      <p className="text-sm text-muted-foreground" aria-live="polite">{list.total.toLocaleString("en-US")} campaign{list.total === 1 ? "" : "s"}</p>
      <CampaignsTable rows={list.rows} />
      <Pagination page={list.page} pageCount={list.pageCount} basePath={BASE} searchParams={{ status: list.status ?? undefined, q: list.q || undefined }} />
    </div>
  );
}
