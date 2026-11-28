"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Copy, Eye, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { archiveEmailTemplateAction, deleteEmailTemplateAction, duplicateEmailTemplateAction } from "@/server/actions/admin-email-template.actions";
import type { TemplateRowView } from "@/server/services/email-template-designer.service";

const STATUS_BADGE = { active: "success", draft: "secondary", archived: "outline" } as const;
const fmt = (d: Date | string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" }).format(new Date(d));
const BASE = "/admin/email-marketing/templates";

export function TemplatesTable({ rows }: { rows: TemplateRowView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function run(label: string, fn: () => Promise<{ success: boolean; message?: string }>, done: string) {
    start(async () => {
      const res = await fn();
      if (res.success) { toast.success(done); router.refresh(); } else toast.error(res.message ?? `${label} failed.`);
    });
  }

  if (rows.length === 0) return <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No templates match. Create your first template to get started.</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr><th className="p-3">Template</th><th className="p-3">Category</th><th className="p-3">Status</th><th className="p-3">Last updated</th><th className="p-3">Created</th><th className="p-3 text-right">Actions</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="p-3"><div className="font-medium">{r.name}</div><div className="max-w-xs truncate text-xs text-muted-foreground">{r.subject}</div>{!r.isDesigner && <div className="text-xs text-muted-foreground">Created outside the designer (preview only)</div>}</td>
              <td className="p-3">{r.category.charAt(0) + r.category.slice(1).toLowerCase()}</td>
              <td className="p-3"><Badge variant={STATUS_BADGE[r.status]}>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</Badge></td>
              <td className="whitespace-nowrap p-3">{fmt(r.updatedAt)}</td>
              <td className="whitespace-nowrap p-3">{fmt(r.createdAt)}</td>
              <td className="p-3">
                <div className="flex flex-wrap justify-end gap-1">
                  {r.isDesigner && r.status !== "archived" && <Button asChild size="sm" variant="outline"><Link href={`${BASE}/${r.id}`}><Pencil /> Edit</Link></Button>}
                  <Button asChild size="sm" variant="outline"><Link href={`${BASE}/${r.id}/preview`}><Eye /> Preview</Link></Button>
                  {r.isDesigner && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run("Duplicate", () => duplicateEmailTemplateAction(r.id), "Copy created as a draft.")}><Copy /> Duplicate</Button>}
                  {r.status !== "archived" && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => { if (confirm(`Archive "${r.name}"? New campaigns can no longer use it. Existing campaigns keep their own copy.`)) run("Archive", () => archiveEmailTemplateAction(r.id), "Template archived."); }}><Archive /> Archive</Button>}
                  <Button type="button" size="sm" variant="outline" disabled={pending || r.campaignCount > 0} title={r.campaignCount > 0 ? `Used by ${r.campaignCount} campaign(s): archive it instead` : undefined}
                    onClick={() => { if (confirm(`Delete "${r.name}" permanently? This cannot be undone.`)) run("Delete", () => deleteEmailTemplateAction(r.id), "Template deleted."); }}><Trash2 /> Delete</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
