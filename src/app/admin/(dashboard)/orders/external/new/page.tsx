import type { Metadata } from "next";
import Link from "next/link";
import { adminListChannels } from "@/server/services/external-order.service";
import { ExternalOrderForm } from "@/features/admin/external-order-form";

export const metadata: Metadata = { title: "Record external order · Admin" };

export default async function NewExternalOrderPage() {
  const channels = (await adminListChannels()).filter((c) => c.kind !== "WEBSITE" && c.isActive);
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Record external order</h1>
        <p className="text-sm text-muted-foreground">
          For sales made on Daraz, Cartup or another channel. This only records the order and (optionally) reduces stock — it never
          sends a notification, takes a payment or books a courier.
        </p>
      </div>
      {channels.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm">No active external channel yet. <Link className="underline" href="/admin/channels">Add one</Link>.</p>
      ) : (
        <ExternalOrderForm channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
      )}
    </div>
  );
}
