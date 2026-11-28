"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COD_RESOLUTION_ACTIONS, COD_RESOLUTION_LABEL } from "@/lib/courier/cod-reconciliation";
import { confirmCodCollectionAction, resolveCodDiscrepancyAction } from "@/server/actions/admin-courier-cod.actions";

/**
 * Staff statement that the cash for a courier-DELIVERED order was collected. A courier's "delivered" is only a claim about the parcel, so this
 * is the one explicit step that records the COD balance payment (and so makes the order PAID). The reason is stored and audited.
 */
export function CodConfirmForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        The courier reported this order delivered. That does not mean the cash reached you. Confirm only once you have checked the courier&apos;s statement or received the money.
      </p>
      <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="What did you check? (e.g. statement 2026-11-20, line 14) — at least 10 characters" />
      <Button
        type="button" size="sm" disabled={pending || reason.trim().length < 10}
        onClick={() => startTransition(async () => {
          const r = await confirmCodCollectionAction({ orderId, reason });
          if (!r.success) return void toast.error(r.message);
          toast.success("Cash collection recorded");
          setReason("");
          router.refresh();
        })}
      >
        {pending ? "Saving…" : "Confirm cash collected"}
      </Button>
    </div>
  );
}

/** Resolves ONE open discrepancy with a mandatory reason. It records a decision; it never edits entries or payments. */
export function CodResolveForm({ orderId, flag }: { orderId: string; flag: { code: string; label: string; amount: number } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<string>(COD_RESOLUTION_ACTIONS[0]);
  const [reason, setReason] = useState("");
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-[auto_1fr_auto]">
      <select value={action} onChange={(e) => setAction(e.target.value)} aria-label={`How to resolve: ${flag.label}`} className="rounded-md border border-input bg-background px-2 py-2 text-sm">
        {COD_RESOLUTION_ACTIONS.map((a) => <option key={a} value={a}>{COD_RESOLUTION_LABEL[a]}</option>)}
      </select>
      <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, at least 10 characters)" aria-label="Reason" />
      <Button
        type="button" size="sm" variant="outline" disabled={pending || reason.trim().length < 10}
        onClick={() => startTransition(async () => {
          const r = await resolveCodDiscrepancyAction({ orderId, flagCode: flag.code, amount: flag.amount, action, reason });
          if (!r.success) return void toast.error(r.message);
          toast.success("Resolution recorded");
          setReason("");
          router.refresh();
        })}
      >
        {pending ? "Saving…" : "Resolve"}
      </Button>
    </div>
  );
}
