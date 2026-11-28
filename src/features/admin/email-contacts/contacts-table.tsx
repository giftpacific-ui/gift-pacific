"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContactActiveButton } from "@/features/admin/email-contacts/contact-active-button";
import { setEmailContactsActiveAction } from "@/server/actions/admin-email-contact.actions";
import {
  CONSENT_STATUS_LABEL, INELIGIBLE_LABEL, SOURCE_LABEL, SUPPRESSION_LABEL, csvSafe, type ConsentStatus, type ContactListRow,
} from "@/lib/email-contacts";
import { formatDate } from "@/lib/utils";

const CONSENT_VARIANT: Record<ConsentStatus, "success" | "destructive" | "secondary" | "outline"> = { given: "success", unsubscribed: "destructive", withdrawn: "secondary", none: "outline" };

export function ContactsTable({ rows }: { rows: ContactListRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const router = useRouter();
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll(on: boolean) { setSelected(on ? new Set(rows.map((r) => r.id)) : new Set()); }
  function toggleOne(id: string, on: boolean) {
    setSelected((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
  }
  function bulk(isActive: boolean) {
    if (!isActive && !confirm(`Deactivate ${selected.size} contact(s)? Their consent and suppression records are kept.`)) return;
    start(async () => {
      const res = await setEmailContactsActiveAction([...selected], isActive);
      if (res.success) { toast.success(`${res.updated} contact(s) ${isActive ? "activated" : "deactivated"}.`); setSelected(new Set()); }
      else toast.error(res.message);
      router.refresh();
    });
  }

  if (rows.length === 0) return <p className="rounded-xl border border-border/70 bg-card p-6 text-sm text-muted-foreground">No contacts match.</p>;

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-3 text-sm" role="status">
          <span className="font-medium">{selected.size} selected</span>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => bulk(false)}>Deactivate</Button>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => bulk(true)}>Activate</Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-250 text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr>
              <th className="w-10 p-3">
                <Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={(v) => toggleAll(v === true)} aria-label="Select all contacts on this page" />
              </th>
              <th className="p-3">Customer / name</th>
              <th className="p-3">Email</th>
              <th className="p-3">Source</th>
              <th className="p-3">Marketing consent</th>
              <th className="p-3">Eligibility</th>
              <th className="p-3">Suppression</th>
              <th className="p-3">Date added</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/50 align-top last:border-0 hover:bg-secondary/40" data-state={selected.has(r.id) ? "selected" : undefined}>
                <td className="p-3"><Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggleOne(r.id, v === true)} aria-label={`Select ${csvSafe(r.email)}`} /></td>
                <td className="p-3">
                  <Link href={`/admin/email-marketing/contacts/${r.id}`} className="font-medium hover:underline">{csvSafe(r.name) || "—"}</Link>
                  {r.customer && <p className="text-xs text-muted-foreground">Customer: {csvSafe(r.customer.name)}</p>}
                  {!r.isActive && <Badge variant="secondary" className="mt-1">Inactive</Badge>}
                </td>
                <td className="max-w-64 break-all p-3">{csvSafe(r.email)}</td>
                <td className="p-3 text-muted-foreground">{SOURCE_LABEL[r.source] ?? r.source}</td>
                <td className="p-3"><Badge variant={CONSENT_VARIANT[r.consentStatus]}>{CONSENT_STATUS_LABEL[r.consentStatus]}</Badge></td>
                <td className="p-3">
                  {r.eligibility.eligible ? <Badge variant="success">Eligible</Badge> : (
                    <>
                      <Badge variant="outline">Not eligible</Badge>
                      <p className="mt-1 text-xs text-muted-foreground">{INELIGIBLE_LABEL[r.eligibility.reason] ?? "Not eligible"}</p>
                    </>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">{r.suppressionReason ? SUPPRESSION_LABEL[r.suppressionReason] ?? r.suppressionReason : "—"}</td>
                <td className="whitespace-nowrap p-3 text-muted-foreground">{formatDate(r.createdAt)}</td>
                <td className="p-3">
                  <div className="flex items-center justify-end gap-2">
                    <Button asChild size="sm" variant="ghost"><Link href={`/admin/email-marketing/contacts/${r.id}`}>View</Link></Button>
                    <ContactActiveButton contactId={r.id} isActive={r.isActive} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
