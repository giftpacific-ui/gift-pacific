import type { Metadata } from "next";
import { getRewardSettings } from "@/server/services/reward.service";
import { RewardSettingsForm } from "@/features/admin/reward-settings-form";

export const metadata: Metadata = { title: "Delivery reward · Admin" };

export default async function AdminRewardsPage() {
  const settings = await getRewardSettings();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Repeat-purchase delivery reward</h1>
        <p className="text-sm text-muted-foreground">
          When an order is marked <strong>Delivered</strong>, the signed-in customer earns a one-time discount on the <em>delivery charge</em> of a later order.
          They choose whether to use it at checkout. Terms are saved with each reward, so changing them here never alters rewards already issued.
          A refunded order withdraws its unused reward; an order that used a reward and is cancelled or fails delivery gives it back.
        </p>
      </div>
      <RewardSettingsForm initial={settings} />
    </div>
  );
}
