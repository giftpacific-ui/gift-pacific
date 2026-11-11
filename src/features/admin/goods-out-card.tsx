import Link from "next/link";
import type { GoodsStillOut } from "@/server/services/incident.service";

/** Shown on an order whose goods have shipped: units are NOT assumed back in stock — record what came back (sellable) or what is unsellable. */
export function GoodsOutCard({ lines }: { lines: GoodsStillOut[] }) {
  if (lines.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" aria-labelledby="goods-out-h">
      <h2 id="goods-out-h" className="font-heading text-base">Goods still out of stock</h2>
      <p className="mt-1 text-muted-foreground">
        These units left with the order and have not been recorded as back. They are <strong>not</strong> in sellable stock until you record a return as sellable.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">{lines.map((l) => <li key={l.lineId}>{l.productName}: <strong>{l.remaining}</strong> still out</li>)}</ul>
      <Link href="/admin/accounts" className="mt-2 inline-block underline underline-offset-4">Record a return or unsellable goods</Link>
    </section>
  );
}
