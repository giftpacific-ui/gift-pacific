"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { addRiskListEntryAction, disableRiskListEntryAction } from "@/server/actions/admin-fraud.actions";
import type { RiskListRow } from "@/server/services/risk-list.service";

const d = (v: Date | string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "—");
const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

export function RiskListManager({ entries }: { entries: RiskListRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ listType: "BLOCK", kind: "PHONE", value: "", reason: "", expiresOn: "" });
  const [disabling, setDisabling] = useState<{ id: string; reason: string } | null>(null);

  const run = (fn: () => Promise<{ success: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.success) { toast.success(r.message ?? "Done."); after?.(); router.refresh(); }
      else toast.error(r.message ?? "Failed.");
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">Add an entry</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <select className={selectClass} value={form.listType} onChange={(e) => setForm({ ...form, listType: e.target.value })} aria-label="List">
              <option value="BLOCK">Block list</option>
              <option value="ALLOW">Allow list</option>
            </select>
            <select className={selectClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Type">
              <option value="PHONE">Phone</option>
              <option value="EMAIL">E-mail</option>
              <option value="IP">IP address</option>
            </select>
            <Input className="w-64" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.kind === "PHONE" ? "01XXXXXXXXX or +8801…" : form.kind === "EMAIL" ? "name@example.com" : "203.0.113.7"} />
            <Input className="w-44" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} aria-label="Expiry date" />
          </div>
          <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Reason (required, recorded with your name and the time)" maxLength={300} />
          <p className="text-xs text-muted-foreground">
            Phone numbers and e-mails are matched in their normalised form. IP blocks must have an expiry (max 90 days) because many customers can share one address; an IP block only sends an order for review. An allow-list entry lowers the score only: it never skips advance verification, the low-trust review or a block.
          </p>
          <Button type="button" disabled={pending} onClick={() => run(() => addRiskListEntryAction(form), () => setForm({ ...form, value: "", reason: "", expiresOn: "" }))}>Add</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Entries</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {entries.length === 0 ? <p className="text-sm text-muted-foreground">No entries.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr><th className="py-2 pr-3">List</th><th className="pr-3">Type</th><th className="pr-3">Value</th><th className="pr-3">Reason</th><th className="pr-3">Added</th><th className="pr-3">Expires</th><th className="pr-3">Status</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {entries.map((e) => (
                  <tr key={e.id} className={e.status === "ACTIVE" ? "" : "text-muted-foreground"}>
                    <td className="py-2 pr-3">{e.listType.toLowerCase()}</td>
                    <td className="pr-3">{e.kind.toLowerCase()}</td>
                    <td className="pr-3 font-mono text-xs">{e.displayValue}</td>
                    <td className="pr-3">{e.reason}{e.disabledReason ? <span className="block text-xs">Disabled: {e.disabledReason}</span> : null}</td>
                    <td className="pr-3">{d(e.createdAt)}<span className="block text-xs">by {e.createdById}</span></td>
                    <td className="pr-3">{d(e.expiresAt)}</td>
                    <td className="pr-3">{e.status.toLowerCase()}</td>
                    <td>
                      {e.status === "ACTIVE" && (disabling?.id === e.id ? (
                        <span className="flex gap-1">
                          <Input className="h-8 w-48" value={disabling.reason} onChange={(ev) => setDisabling({ id: e.id, reason: ev.target.value })} placeholder="Reason to disable" />
                          <Button type="button" size="sm" disabled={pending} onClick={() => run(() => disableRiskListEntryAction({ id: e.id, reason: disabling.reason }), () => setDisabling(null))}>Confirm</Button>
                        </span>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => setDisabling({ id: e.id, reason: "" })}>Disable</Button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
