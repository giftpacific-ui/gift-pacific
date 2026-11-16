"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveRedirectAction, deleteRedirectAction } from "@/server/actions/admin-seo.actions";
import { SaveMessage } from "./seo-fields";

export type RedirectRow = { id: string; fromPath: string; toPath: string; statusCode: number; isActive: boolean };
const blank = { id: "", fromPath: "", toPath: "", statusCode: 301, isActive: true };

export function RedirectManager({ rows }: { rows: RedirectRow[] }) {
  const router = useRouter();
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function save(next = form, done = "Redirect saved.") {
    setMsg(null);
    start(async () => {
      const r = await saveRedirectAction({ ...next });
      if (!r.success) return setMsg({ ok: false, text: r.message });
      setMsg({ ok: true, text: done });
      setForm(blank);
      router.refresh();
    });
  }
  function remove(id: string) {
    if (!window.confirm("Delete this redirect?")) return;
    start(async () => {
      const r = await deleteRedirectAction(id);
      if (r.success) router.refresh(); else setMsg({ ok: false, text: r.message });
    });
  }

  return (
    <div className="space-y-6">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">{form.id ? "Edit redirect" : "New redirect"}</h2>
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_9rem]">
          <div className="space-y-1.5"><Label htmlFor="r-from">Old path</Label><Input id="r-from" placeholder="/old-page" value={form.fromPath} onChange={(e) => setForm({ ...form, fromPath: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="r-to">New path</Label><Input id="r-to" placeholder="/new-page" value={form.toPath} onChange={(e) => setForm({ ...form, toPath: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="r-code">Type</Label>
            <select id="r-code" className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm" value={form.statusCode} onChange={(e) => setForm({ ...form, statusCode: Number(e.target.value) })}>
              <option value={301}>301 permanent</option><option value={302}>302 temporary</option></select></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Active</label>
        <p className="text-xs text-muted-foreground">Paths on this site only (external destinations are refused). Loops are detected before saving. Changes reach every server within about 30 seconds.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : form.id ? "Update" : "Add redirect"}</Button>
          {form.id && <Button type="button" variant="ghost" onClick={() => { setForm(blank); setMsg(null); }}>Cancel</Button>}
          <SaveMessage state={msg} />
        </div>
      </form>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-secondary/50 text-left text-xs uppercase"><tr><th className="p-3">Old path</th><th className="p-3">New path</th><th className="p-3">Type</th><th className="p-3">Status</th><th className="p-3 text-right">Actions</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/60">
                <td className="max-w-56 truncate p-3 font-mono text-xs">{r.fromPath}</td>
                <td className="max-w-56 truncate p-3 font-mono text-xs">{r.toPath}</td>
                <td className="p-3">{r.statusCode}</td>
                <td className="p-3"><Badge variant={r.isActive ? "success" : "secondary"}>{r.isActive ? "Active" : "Inactive"}</Badge></td>
                <td className="space-x-1 p-3 text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => { setForm({ ...r }); setMsg(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => save({ ...r, isActive: !r.isActive }, r.isActive ? "Deactivated." : "Activated.")}>{r.isActive ? "Deactivate" : "Activate"}</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => remove(r.id)}>Delete</Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No redirects match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
