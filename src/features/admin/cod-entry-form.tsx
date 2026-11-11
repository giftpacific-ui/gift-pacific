"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COD_ENTRY_KINDS, COD_KIND_LABEL } from "@/lib/courier/cod-reconciliation";
import { recordCodEntryAction } from "@/server/actions/admin-courier-cod.actions";

/** Records ONE new append-only entry. There is no edit or delete: a mistake is corrected with an ADJUSTMENT. */
export function CodEntryForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<string>("COLLECTION_REPORTED");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs">
        <span className="mb-1 block text-muted-foreground">Record</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
          {COD_ENTRY_KINDS.map((k) => <option key={k} value={k}>{COD_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-muted-foreground">Amount (৳){kind === "ADJUSTMENT" ? " — negative to reduce" : ""}</span>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-muted-foreground">Courier statement / settlement reference</span>
        <Input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-muted-foreground">Note{kind === "ADJUSTMENT" ? " (required)" : " (optional)"}</span>
        <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="sm:col-span-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || amount.trim() === ""}
          onClick={() =>
            startTransition(async () => {
              const result = await recordCodEntryAction({ orderId, kind, amount: Number(amount), reference, note });
              if (!result.success) return void toast.error(result.message);
              toast.success("Entry recorded");
              setAmount(""); setReference(""); setNote("");
              router.refresh();
            })
          }
        >
          {pending ? "Saving…" : "Add entry"}
        </Button>
      </div>
    </div>
  );
}
