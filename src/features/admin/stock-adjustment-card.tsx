"use client";

import { useState, useTransition } from "react";
import { useReportDirty } from "@/features/admin/product-editor-dirty";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adjustStockAction } from "@/server/actions/admin-stock.actions";
import { formatDate } from "@/lib/utils";

type Row = {
  id: string;
  delta: number;
  stockAfter: number;
  reason: string;
  createdAt: Date | string;
  variantName: string | null;
};

export function StockAdjustmentCard({
  productId,
  isVariantProduct,
  variants,
  stock,
  history,
}: {
  productId: string;
  isVariantProduct: boolean;
  variants: { id: string; name: string; stock: number }[];
  stock: number;
  history: Row[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [variantId, setVariantId] = useState(variants[0]?.id ?? "");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID()); // one key per attempt: a retry cannot adjust twice

  useReportDirty("stock-adjustment", delta !== "" || reason !== "" || isPending);

  const current = isVariantProduct
    ? (variants.find((v) => v.id === variantId)?.stock ?? 0)
    : stock;

  function submit() {
    startTransition(async () => {
      const result = await adjustStockAction(
        productId,
        isVariantProduct ? variantId : null,
        Number(delta),
        reason,
        key,
      );
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(`Stock is now ${result.stockAfter}`);
      setDelta("");
      setReason("");
      setKey(crypto.randomUUID());
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {isVariantProduct && (
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm sm:col-span-4"
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
          >
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} (stock {v.stock})
              </option>
            ))}
          </select>
        )}
        <Input
          type="number"
          step={1}
          placeholder="+10 or -3"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          aria-label="Change in units"
        />
        <Input
          className="sm:col-span-2"
          placeholder="Reason (e.g. recount, damaged, restock)"
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
        />
        <Button
          onClick={submit}
          disabled={
            isPending ||
            !delta ||
            reason.trim().length < 3 ||
            (isVariantProduct && !variantId)
          }
        >
          {isPending ? "Saving…" : "Adjust"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Current stock: <span className="font-medium">{current}</span>.
        Adjustments are relative, so they stay correct even if an order is
        placed at the same moment.
      </p>

      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No manual adjustments yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">Item</th>
                <th className="py-1 pr-3 font-medium">Change</th>
                <th className="py-1 pr-3 font-medium">New stock</th>
                <th className="py-1 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-t border-border/50">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {formatDate(row.createdAt)}
                  </td>
                  <td className="py-1.5 pr-3">{row.variantName ?? "—"}</td>
                  <td
                    className={`py-1.5 pr-3 font-medium ${
                      row.delta < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {row.delta > 0 ? `+${row.delta}` : row.delta}
                  </td>
                  <td className="py-1.5 pr-3">{row.stockAfter}</td>
                  <td className="py-1.5">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
