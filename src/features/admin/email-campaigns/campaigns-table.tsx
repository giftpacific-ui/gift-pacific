import Link from "next/link";
import type { CampaignListRow } from "@/lib/email-campaigns";
import { CampaignActionButtons } from "./campaign-action-buttons";
import { CampaignStatusBadge, formatDhaka } from "./campaign-status-badge";

const n = (v: number) => v.toLocaleString("en-US");

export function CampaignsTable({ rows }: { rows: CampaignListRow[] }) {
  if (rows.length === 0) {
    return <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No campaigns match. Create your first campaign to get started.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="p-3">Campaign</th><th className="p-3">Template</th><th className="p-3">Status</th><th className="p-3">Scheduled (Dhaka)</th>
            <th className="p-3 text-right">Audience</th><th className="p-3 text-right">Sent</th><th className="p-3 text-right">Failed</th><th className="p-3 text-right">Skipped</th>
            <th className="p-3">Created</th><th className="p-3">Updated</th><th className="p-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="p-3"><Link href={`/admin/email-marketing/campaigns/${r.id}`} className="font-medium hover:underline">{r.name}</Link><div className="max-w-xs truncate text-xs text-muted-foreground">{r.subject}</div></td>
              <td className="p-3">{r.templateName ?? <span className="text-muted-foreground">Template removed</span>}{r.templateCategory && <div className="text-xs text-muted-foreground">{r.templateCategory.charAt(0) + r.templateCategory.slice(1).toLowerCase()}</div>}</td>
              <td className="p-3"><CampaignStatusBadge status={r.status} /></td>
              <td className="whitespace-nowrap p-3">{formatDhaka(r.scheduledAt)}</td>
              <td className="p-3 text-right tabular-nums">{n(r.recipientCount)}</td>
              <td className="p-3 text-right tabular-nums">{n(r.sentCount)}</td>
              <td className="p-3 text-right tabular-nums">{n(r.failedCount)}</td>
              <td className="p-3 text-right tabular-nums">{n(r.skippedCount)}</td>
              <td className="whitespace-nowrap p-3">{formatDhaka(r.createdAt)}</td>
              <td className="whitespace-nowrap p-3">{formatDhaka(r.updatedAt)}</td>
              <td className="p-3"><CampaignActionButtons id={r.id} name={r.name} status={r.status} actions={r.actions} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
