"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { retryEmailJobsAction } from "@/server/actions/admin-email-queue.actions";
import type { QueueJobRow } from "@/server/services/admin-email-queue.service";
import { formatDhaka } from "@/features/admin/email-campaigns/campaign-status-badge";

/**
 * Pending / Failed e-mail jobs with multi-select and a Retry button. Retry is a server action that re-checks everything on the server (the browser sends only the
 * selected ids), awaits ONE bounded run of the existing e-mail worker, and reports exactly what happened. Rows that cannot be retried are not selectable and show why.
 * Nothing here polls, refreshes on a timer or retries by itself.
 */
export function QueueJobsTable({ rows, selectionLimit, batchLimit }: { rows: QueueJobRow[]; selectionLimit: number; batchLimit: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const busy = useRef(false); // a second click while a request is running must not send a second request
  const retryable = useMemo(() => rows.filter((r) => r.retryable), [rows]);
  const allOn = retryable.length > 0 && retryable.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else if (next.size < selectionLimit) next.add(id); return next; });
  }
  function retry() {
    if (busy.current || selected.size === 0) return;
    if (!confirm(`Retry ${selected.size} e-mail(s) now?\n\nUp to ${batchLimit} are sent in this request while the page waits. The rest stay as they are and can be retried again. Consent, suppression and unsubscribe rules are checked again for every e-mail.`)) return;
    busy.current = true;
    start(async () => {
      try {
        const res = await retryEmailJobsAction([...selected]);
        if (res.success) { toast.success(res.message, { duration: 10000 }); setSelected(new Set()); router.refresh(); } else toast.error(res.message);
      } finally { busy.current = false; }
    });
  }

  if (rows.length === 0) return <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No e-mails in this state.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">{selected.size} selected (at most {selectionLimit}; {batchLimit} are sent per click)</p>
        <Button type="button" size="sm" disabled={pending || selected.size === 0} onClick={retry}><RotateCcw /> {pending ? "Retrying…" : "Retry selected"}</Button>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-10 p-2"><input type="checkbox" aria-label="Select all retryable e-mails on this page" checked={allOn} disabled={retryable.length === 0 || pending}
                onChange={() => setSelected(allOn ? new Set() : new Set(retryable.slice(0, selectionLimit).map((r) => r.id)))} /></th>
              <th className="p-2">E-mail</th><th className="p-2">Kind</th><th className="p-2">Status</th><th className="p-2">Attempts</th><th className="p-2">Error</th><th className="p-2">Queued</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="p-2"><input type="checkbox" aria-label={`Select e-mail to ${r.toEmail}`} checked={selected.has(r.id)} disabled={!r.retryable || pending} onChange={() => toggle(r.id)} /></td>
                <td className="p-2"><div className="font-medium">{r.toEmail}</div><div className="text-xs text-muted-foreground">{r.subject}</div></td>
                <td className="p-2">{r.kind}</td>
                <td className="p-2"><Badge variant={r.status === "FAILED" ? "destructive" : "secondary"}>{r.status === "FAILED" ? "Failed" : "Pending"}</Badge>
                  {r.status === "PENDING" && <div className="mt-1 text-xs text-muted-foreground">next attempt {formatDhaka(r.nextAttemptAt)}</div>}</td>
                <td className="p-2">{r.attempts}</td>
                <td className="p-2 text-xs">{r.errorCode ? <><code>{r.errorCode}</code>{r.errorMessage ? <div className="text-muted-foreground">{r.errorMessage}</div> : null}</> : "—"}
                  {!r.retryable && r.retryBlockedReason && <div className="mt-1 text-muted-foreground">Not retryable: {r.retryBlockedReason}</div>}</td>
                <td className="p-2 text-xs text-muted-foreground">{formatDhaka(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
