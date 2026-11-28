"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { sendAbandonedCartRemindersAction } from "@/server/actions/admin-email-queue.actions";

export type AbandonedCartRow = {
  id: string;
  customer: { name: string; email: string } | null;
  lastActivityLabel: string;
  itemCount: number;
  items: { name: string; variant: string | null; quantity: number; unavailable: boolean }[];
  reminder: { status: string; label: string } | null;
};

/**
 * Abandoned carts with checkboxes and one explicit "Send reminders" button. The browser sends only the selected cart ids and the period; the server re-derives
 * every cart, re-checks consent and suppression, queues the reminder on the existing e-mail queue and sends ONE bounded batch while this page waits. Guest carts
 * cannot be selected (no address). Nothing is detected or sent unless this button is clicked.
 */
export function AbandonedCartList({ carts, hours, selectionLimit }: { carts: AbandonedCartRow[]; hours: number; selectionLimit: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const busy = useRef(false);
  const selectable = (c: AbandonedCartRow) => c.customer !== null && c.reminder === null;

  function toggle(id: string) {
    setSelected((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else if (next.size < selectionLimit) next.add(id); return next; });
  }
  function send() {
    if (busy.current || selected.size === 0) return;
    if (!confirm(`Send reminder e-mails for ${selected.size} cart(s) now?\n\nOnly customers with valid marketing consent who are not suppressed are mailed; everyone else is skipped. A limited batch is sent while this page waits; anything not reached stays Pending on the Send queue page. Nothing is sent in the background.`)) return;
    busy.current = true;
    start(async () => {
      try {
        const res = await sendAbandonedCartRemindersAction([...selected], hours);
        if (res.success) {
          toast.success(res.message, { duration: 12000 });
          if (res.skipped.length) toast.message(`Skipped: ${[...new Set(res.skipped.map((s) => s.label))].join("; ")}`, { duration: 12000 });
          setSelected(new Set()); router.refresh();
        } else toast.error(res.message);
      } finally { busy.current = false; }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">{selected.size} selected (at most {selectionLimit} per click)</p>
        <Button type="button" size="sm" disabled={pending || selected.size === 0} onClick={send}><Send /> {pending ? "Sending…" : "Send reminders"}</Button>
      </div>
      <ul className="space-y-3">
        {carts.map((cart) => (
          <li key={cart.id} className="space-y-2 rounded-xl border border-border/70 bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={selected.has(cart.id)} disabled={!selectable(cart) || pending} onChange={() => toggle(cart.id)}
                  aria-label={cart.customer ? `Select the cart of ${cart.customer.email}` : "Guest carts cannot be mailed"} />
                {cart.customer ? `${cart.customer.name} · ${cart.customer.email}` : "Guest visitor"}
              </label>
              <p className="text-xs text-muted-foreground">{cart.itemCount} item{cart.itemCount === 1 ? "" : "s"} · last activity {cart.lastActivityLabel}</p>
            </div>
            {cart.reminder && <Badge variant={cart.reminder.status === "SENT" ? "success" : cart.reminder.status === "FAILED" ? "destructive" : "secondary"}>{cart.reminder.label}</Badge>}
            {!cart.customer && <p className="text-xs text-muted-foreground">Guest cart: no e-mail address is known, so it cannot be mailed.</p>}
            <ul className="text-sm text-muted-foreground">
              {cart.items.map((item, i) => (
                <li key={i}>{item.quantity}× {item.name}{item.variant ? ` — ${item.variant}` : ""}{item.unavailable ? " (no longer available)" : ""}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
