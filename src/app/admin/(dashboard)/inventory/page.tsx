import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { INVENTORY_STATE_LABEL, inventoryState, type InventoryState } from "@/lib/inventory-status";
import { ReceiveProcurementForm } from "@/features/admin/receive-procurement-form";
import { InventoryReconcileCard } from "@/features/admin/inventory-reconcile-card";
import { previewInventoryReconciliation } from "@/server/services/inventory-reconcile.service";

export const metadata: Metadata = { title: "Inventory · Admin" };

const FILTERS: { key: string; label: string; match: (s: InventoryState) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "low", label: "Low stock", match: (s) => s === "low_stock" },
  { key: "out", label: "Out of stock", match: (s) => s === "out_of_stock" },
  { key: "procurement", label: "Procurement", match: (s) => s === "procurement_required" || s === "procurement_pending" },
  { key: "untracked", label: "Not tracked", match: (s) => s === "untracked" },
];

type Row = { productId: string; variantId: string | null; name: string; sku: string | null; state: InventoryState; stock: number; pending: number; limit: number | null; threshold: number };

export default async function AdminInventoryPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter = "all" } = await searchParams;
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const products = await prisma.product.findMany({
    where: { status: { not: "ARCHIVED" }, kind: "SINGLE" },
    orderBy: { name: "asc" }, take: 1000,
    select: { id: true, name: true, sku: true, type: true, stock: true, trackInventory: true, lowStockThreshold: true, allowBackorder: true, procurementPending: true, procurementLimit: true,
      variants: { select: { id: true, name: true, sku: true, stock: true, allowBackorder: true, procurementPending: true, procurementLimit: true } } },
  });
  const rows: Row[] = [];
  for (const p of products) {
    if (p.type === "VARIANT") {
      for (const v of p.variants) rows.push({ productId: p.id, variantId: v.id, name: `${p.name} — ${v.name}`, sku: v.sku, stock: v.stock, pending: v.procurementPending, limit: v.procurementLimit, threshold: p.lowStockThreshold,
        state: inventoryState({ trackInventory: p.trackInventory, stock: v.stock, lowStockThreshold: p.lowStockThreshold, allowBackorder: v.allowBackorder, procurementPending: v.procurementPending, procurementLimit: v.procurementLimit }) });
    } else {
      rows.push({ productId: p.id, variantId: null, name: p.name, sku: p.sku, stock: p.stock, pending: p.procurementPending, limit: p.procurementLimit, threshold: p.lowStockThreshold,
        state: inventoryState({ trackInventory: p.trackInventory, stock: p.stock, lowStockThreshold: p.lowStockThreshold, allowBackorder: p.allowBackorder, procurementPending: p.procurementPending, procurementLimit: p.procurementLimit }) });
    }
  }
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter((r) => f.match(r.state)).length]));
  const shown = rows.filter((r) => active.match(r.state));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Inventory</h1>
        <p className="text-sm text-muted-foreground">
          <strong>Available</strong> is what can still be sold: units are taken from stock the moment an order is placed. <strong>To source</strong> counts units
          customers ordered beyond stock (procurement-enabled products); they are tracked separately and never added to stock until received here.
        </p>
      </div>
      <InventoryReconcileCard report={await previewInventoryReconciliation()} />
      <nav className="flex flex-wrap gap-2" aria-label="Inventory filters">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key === "all" ? "/admin/inventory" : `/admin/inventory?filter=${f.key}`} aria-current={f.key === active.key ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${f.key === active.key ? "border-foreground bg-secondary" : "border-border"}`}>{f.label} ({counts[f.key]})</Link>
        ))}
      </nav>
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">Nothing in this view.</p> : (
        <div className="overflow-x-auto rounded-xl border border-border/70">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-left"><tr><th className="p-3">Product</th><th className="p-3">Status</th><th className="p-3 text-right">Available</th><th className="p-3 text-right">To source</th><th className="p-3 text-right">Limit</th><th className="p-3">Receive goods</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.productId}:${r.variantId ?? ""}`} className="border-t border-border/60 align-top">
                  <td className="p-3"><Link className="underline-offset-4 hover:underline" href={`/admin/products/${r.productId}`}>{r.name}</Link>{r.sku && <span className="block text-xs text-muted-foreground">{r.sku}</span>}</td>
                  <td className="p-3">{INVENTORY_STATE_LABEL[r.state]}</td>
                  <td className="p-3 text-right tabular-nums">{r.state === "untracked" ? "—" : r.stock}</td>
                  <td className="p-3 text-right tabular-nums">{r.pending}</td>
                  <td className="p-3 text-right tabular-nums">{r.limit ?? "none"}</td>
                  <td className="p-3">{r.state === "untracked" ? null : <ReceiveProcurementForm productId={r.productId} variantId={r.variantId} defaultQuantity={r.pending} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
