import type { Metadata } from "next";
import { adminListChannels } from "@/server/services/external-order.service";
import { ChannelsManager } from "@/features/admin/channels-manager";

export const metadata: Metadata = { title: "Channels · Admin" };

export default async function ChannelsPage() {
  const channels = await adminListChannels();
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Sales channels</h1>
        <p className="text-sm text-muted-foreground">Where orders come from. Channels are separate from order status and from product categories; deactivating one hides it from new orders but keeps its history.</p>
      </div>
      <ChannelsManager channels={channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, isActive: c.isActive }))} />
    </div>
  );
}
