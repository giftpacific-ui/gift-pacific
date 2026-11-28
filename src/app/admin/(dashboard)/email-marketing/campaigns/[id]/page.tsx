import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminGetCampaignDetail } from "@/server/services/admin-email-campaign.service";
import { RECIPIENT_STATUSES, RECIPIENT_STATUS_LABEL, reasonLabel } from "@/lib/email-campaigns";
import { Pagination } from "@/components/shared/pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CampaignActionButtons } from "@/features/admin/email-campaigns/campaign-action-buttons";
import { CampaignStatusBadge, formatDhaka } from "@/features/admin/email-campaigns/campaign-status-badge";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Campaign · Email marketing · Admin" };
// Send now / Continue sending are server actions that run inside this page's function: the Hobby limit declared here bounds them. (A literal, as Next.js requires; equals the request budget in src/lib/email/queue-policy.ts.)
export const maxDuration = 60;
const BASE = "/admin/email-marketing/campaigns";
const n = (v: number) => v.toLocaleString("en-US");
const RECIPIENT_BADGE = { PENDING: "secondary", QUEUED: "accent", SENT: "success", FAILED: "destructive", SKIPPED: "outline" } as const;

export default async function EmailCampaignDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const res = await adminGetCampaignDetail(admin.id, id, { page: sp.page, status: sp.recipients });
  if (!res.ok) { if (res.code === "not_found") return notFound(); return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{res.message}</p>; }
  const c = res.campaign;
  const d = c.delivery;
  const filterHref = (status: string | null) => `${BASE}/${c.id}${status ? `?recipients=${status}` : ""}`;
  const cards = [
    { label: "Audience", value: d.total }, { label: "Pending", value: d.pending }, { label: "Queued", value: d.queued },
    { label: "Sent", value: d.sent }, { label: "Failed", value: d.failed }, { label: "Skipped", value: d.skipped },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl">{c.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><CampaignStatusBadge status={c.status} /><span>Created {formatDhaka(c.createdAt)}</span><span>· Updated {formatDhaka(c.updatedAt)}</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost"><Link href={BASE}>Back to campaigns</Link></Button>
          <CampaignActionButtons id={c.id} name={c.name} status={c.status} actions={c.actions} showView={false} />
        </div>
      </div>

      {c.status === "FAILED" && <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> This campaign could not be sent{c.failureCode ? `: ${reasonLabel(c.failureCode)}` : ""}.</p>}
      {c.status === "SCHEDULED" && <p className="rounded-md border bg-muted/30 p-3 text-sm">This campaign was scheduled for <strong>{formatDhaka(c.scheduledAt)}</strong> (Asia/Dhaka) before immediate sending was introduced. The automatic dispatcher still starts it when due; you can also move it back to draft and send it now.</p>}

      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <div className="text-xs uppercase text-muted-foreground">Campaign</div>
          {c.description && <div>{c.description}</div>}
          <div>Subject: <span className="font-medium">{c.subject}</span></div>
          <div>Sender: {c.senderName || c.senderEmail ? `${c.senderName ?? ""} ${c.senderEmail ? `<${c.senderEmail}>` : ""}`.trim() : "Store default sender"}</div>
          <div className="flex items-center gap-1">{c.hasUnsubscribeLink ? <><CheckCircle2 className="size-4 text-green-600" /> Unsubscribe link present</> : <><AlertTriangle className="size-4 text-destructive" /> Unsubscribe link missing</>}</div>
        </CardContent></Card>
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <div className="text-xs uppercase text-muted-foreground">Template</div>
          {c.template ? <><div className="font-medium">{c.template.name}</div><div>{c.template.category.charAt(0) + c.template.category.slice(1).toLowerCase()}{!c.template.isActive && <Badge variant="outline" className="ml-2">Archived</Badge>}</div><Link className="text-primary hover:underline" href={`/admin/email-marketing/templates/${c.template.id}/preview`}>Preview template</Link></> : <div className="text-muted-foreground">The template was removed. This campaign keeps its own copy of the message.</div>}
          <div className="text-xs text-muted-foreground">The campaign uses its own copy of the template made when it was created.</div>
        </CardContent></Card>
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <div className="text-xs uppercase text-muted-foreground">Timeline (Asia/Dhaka)</div>
          <div>Scheduled: {formatDhaka(c.scheduledAt)}</div><div>Started: {formatDhaka(c.startedAt)}</div><div>Completed: {formatDhaka(c.completedAt)}</div>{c.cancelledAt && <div>Cancelled: {formatDhaka(c.cancelledAt)}</div>}
        </CardContent></Card>
      </div>

      <section aria-labelledby="progress" className="space-y-3">
        <h2 id="progress" className="font-heading text-xl">Delivery progress</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {cards.map((s) => <Card key={s.label}><CardContent className="p-4"><div className="text-xs uppercase text-muted-foreground">{s.label}</div><div className="text-2xl font-semibold tabular-nums">{n(s.value)}</div></CardContent></Card>)}
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{n(d.processed)} of {n(d.total)} processed</span><span>{d.percent}%</span></div>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.percent} aria-label="Delivery progress" className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${d.percent}%` }} /></div>
        </div>
        {(c.skipReasons.length > 0 || c.failureCodes.length > 0) && (
          <div className="grid gap-3 md:grid-cols-2">
            {c.skipReasons.length > 0 && <Card><CardContent className="p-4 text-sm"><div className="mb-1 text-xs uppercase text-muted-foreground">Why recipients were skipped</div><ul className="space-y-1">{c.skipReasons.map((r) => <li key={r.code} className="flex justify-between gap-2"><span>{reasonLabel(r.code)}</span><span className="tabular-nums">{n(r.count)}</span></li>)}</ul></CardContent></Card>}
            {c.failureCodes.length > 0 && <Card><CardContent className="p-4 text-sm"><div className="mb-1 text-xs uppercase text-muted-foreground">Why e-mails failed</div><ul className="space-y-1">{c.failureCodes.map((r) => <li key={r.code} className="flex justify-between gap-2"><span>{reasonLabel(r.code)}</span><span className="tabular-nums">{n(r.count)}</span></li>)}</ul></CardContent></Card>}
          </div>
        )}
      </section>

      <section aria-labelledby="recipients" className="space-y-3">
        <h2 id="recipients" className="font-heading text-xl">Recipients</h2>
        <nav aria-label="Recipient status filters" className="flex gap-2 overflow-x-auto pb-1">
          {[null, ...RECIPIENT_STATUSES].map((s) => (
            <Link key={s ?? "all"} href={filterHref(s)} aria-current={c.recipients.status === s ? "page" : undefined}
              className={cn("whitespace-nowrap rounded-full border px-3 py-1.5 text-sm", c.recipients.status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-secondary")}>
              {s ? RECIPIENT_STATUS_LABEL[s] : "All"}
            </Link>
          ))}
        </nav>
        {c.recipients.rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">{d.total === 0 ? "No audience has been prepared for this campaign yet." : "No recipients match this filter."}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground"><tr><th className="p-3">Contact</th><th className="p-3">Status</th><th className="p-3">Reason</th><th className="p-3">Queued</th><th className="p-3">Sent</th><th className="p-3">Updated</th></tr></thead>
              <tbody>
                {c.recipients.rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="p-3"><Link href={`/admin/email-marketing/contacts/${r.contactId}`} className="font-medium hover:underline">{r.email ?? "Contact removed"}</Link>{r.name && <div className="text-xs text-muted-foreground">{r.name}</div>}</td>
                    <td className="p-3"><Badge variant={RECIPIENT_BADGE[r.status]}>{RECIPIENT_STATUS_LABEL[r.status]}</Badge></td>
                    <td className="p-3">{reasonLabel(r.reason)}</td>
                    <td className="whitespace-nowrap p-3">{formatDhaka(r.queuedAt)}</td><td className="whitespace-nowrap p-3">{formatDhaka(r.sentAt)}</td><td className="whitespace-nowrap p-3">{formatDhaka(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-muted-foreground" aria-live="polite">{n(c.recipients.total)} recipient{c.recipients.total === 1 ? "" : "s"}</p>
        <Pagination page={c.recipients.page} pageCount={c.recipients.pageCount} basePath={`${BASE}/${c.id}`} searchParams={{ recipients: c.recipients.status ?? undefined }} />
      </section>
    </div>
  );
}
