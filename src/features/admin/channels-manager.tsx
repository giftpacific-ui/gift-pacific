"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { saveChannelAction } from "@/server/actions/admin-external-order.actions";

export type ChannelRow = { id: string; name: string; kind: "WEBSITE" | "MARKETPLACE" | "OTHER"; isActive: boolean };

export function ChannelsManager({ channels }: { channels: ChannelRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"MARKETPLACE" | "OTHER">("MARKETPLACE");
  const run = (fn: () => Promise<{ success: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.success) return void toast.error(r.message ?? "Something went wrong.");
      after?.();
      router.refresh();
    });
  return (
    <div className="space-y-6">
      <ul className="space-y-2">
        {channels.map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded-xl border border-border/70 bg-card p-4 text-sm">
            <span className="font-medium">{c.name} <span className="text-muted-foreground">· {c.kind === "WEBSITE" ? "this website" : c.kind.toLowerCase()}</span></span>
            <span className="flex items-center gap-3">
              <Badge variant={c.isActive ? "success" : "secondary"}>{c.isActive ? "Active" : "Inactive"}</Badge>
              {c.kind !== "WEBSITE" && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => saveChannelAction(c.id, { name: c.name, kind: c.kind as "MARKETPLACE" | "OTHER", isActive: !c.isActive }))}>
                  {c.isActive ? "Deactivate" : "Activate"}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">New channel<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Facebook Shop" maxLength={60} /></label>
        <select aria-label="Channel type" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={(e) => setKind(e.target.value as "MARKETPLACE" | "OTHER")}><option value="MARKETPLACE">Marketplace</option><option value="OTHER">Other</option></select>
        <Button disabled={pending || !name.trim()} onClick={() => run(() => saveChannelAction(null, { name, kind, isActive: true }), () => setName(""))}>Add channel</Button>
      </div>
    </div>
  );
}
