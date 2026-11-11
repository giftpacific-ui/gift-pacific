"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { receiveProcurementAction } from "@/server/actions/admin-inventory.actions";

export function ReceiveProcurementForm({ productId, variantId, defaultQuantity }: { productId: string; variantId: string | null; defaultQuantity: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cost, setCost] = useState("");
  // One key per attempt: a double-click or retry cannot allocate the same goods twice. A new key is issued after the server accepted it.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [qty, setQty] = useState(defaultQuantity > 0 ? String(defaultQuantity) : "");
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => {
      e.preventDefault();
      const quantity = Number(qty);
      if (!Number.isInteger(quantity) || quantity < 1) return toast.error("Enter a whole number of units received.");
      start(async () => {
        const r = await receiveProcurementAction({ productId, variantId, quantity, totalCost: cost.trim() === "" ? null : Number(cost), idempotencyKey: key });
        // Keep the typed value on failure; clear it only after the server accepted the receipt.
        if (r.success) { toast.success(r.message); setQty(""); setCost(""); setKey(crypto.randomUUID()); router.refresh(); } else toast.error(r.message);
      });
    }}>
      <Input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} className="h-8 w-24" aria-label="Units received" />
      <Input type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className="h-8 w-28" placeholder="Total cost" aria-label="Total purchase cost (optional)" />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Receive"}</Button>
    </form>
  );
}
