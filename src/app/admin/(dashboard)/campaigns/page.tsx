import type { Metadata } from "next";
import { adminListCampaigns } from "@/server/services/admin-campaign.service";
import { CampaignCard, CampaignForm, type CampaignView } from "@/features/admin/campaign-manager";

export const metadata: Metadata = { title: "Campaigns · Admin" };

// Dates are shown/edited as store-time (UTC+6) calendar days.
const toDay = (d: Date | null) => (d ? new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10) : null);

export default async function AdminCampaignsPage() {
  const campaigns = await adminListCampaigns();
  const views: CampaignView[] = campaigns.map((c) => ({ ...c, startsAt: toDay(c.startsAt), endsAt: toDay(c.endsAt) }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Campaigns</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          A campaign gathers products on the public <code>/campaign</code> page while it is active and
          inside its dates. To advertise it on the home page, add a banner with the placement
          &ldquo;Campaign banner&rdquo; (it links to /campaign). If several campaigns overlap, the most
          recently created one is shown.
        </p>
      </div>
      <div className="rounded-xl border border-border/70 bg-card p-5">
        <h2 className="mb-3 font-heading text-lg">New campaign</h2>
        <CampaignForm />
      </div>
      {views.map((campaign) => (
        <CampaignCard key={campaign.id} campaign={campaign} />
      ))}
    </div>
  );
}
