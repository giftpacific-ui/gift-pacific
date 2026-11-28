import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminGetCampaignDraftForWizard, adminListCampaignTemplates } from "@/server/services/admin-email-campaign.service";
import { isRecordId } from "@/lib/email/template-rules";
import { Button } from "@/components/ui/button";
import { CampaignWizard, type WizardInitial } from "@/features/admin/email-campaigns/campaign-wizard";

export const metadata: Metadata = { title: "New campaign · Email marketing · Admin" };
// Send now / Continue sending are server actions that run inside this page's function: the Hobby limit declared here bounds them. (A literal, as Next.js requires; equals the request budget in src/lib/email/queue-policy.ts.)
export const maxDuration = 60;
const BASE = "/admin/email-marketing/campaigns";

export default async function NewEmailCampaignPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const templates = await adminListCampaignTemplates(admin.id);

  let initial: WizardInitial = { campaignId: null, details: { name: "", description: "", senderName: "", senderEmail: "" }, templateId: null, audience: null, step: 1 };
  if (sp.campaign) {
    const draft = isRecordId(sp.campaign) ? await adminGetCampaignDraftForWizard(admin.id, sp.campaign) : null;
    if (!draft || !draft.ok) {
      return (
        <div className="space-y-4">
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{draft && !draft.ok ? draft.message : "Campaign not found."}</p>
          <Button asChild variant="outline"><Link href={BASE}>Back to campaigns</Link></Button>
        </div>
      );
    }
    // Resume where the draft allows: no template -> step 2, no eligible audience -> step 3; never past what the saved data supports.
    const wanted = Number(sp.step);
    const furthest = !draft.campaign.templateId ? 2 : draft.audience.eligible < 1 ? 3 : 4;
    const step = Number.isInteger(wanted) && wanted >= 1 ? Math.min(wanted, furthest) : Math.min(furthest, 3);
    initial = {
      campaignId: draft.campaign.id, templateId: draft.campaign.templateId, audience: draft.audience, step,
      details: { name: draft.campaign.name, description: draft.campaign.description, senderName: draft.campaign.senderName, senderEmail: draft.campaign.senderEmail },
    };
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">{initial.campaignId ? "Edit campaign" : "New campaign"}</h1>
          <p className="text-sm text-muted-foreground">Four short steps: details, template, audience, and review and send. Your progress is saved as a draft once you choose a template.</p>
        </div>
        <Button asChild variant="ghost"><Link href={BASE}>Back to campaigns</Link></Button>
      </div>
      <CampaignWizard initial={initial} templates={templates} />
    </div>
  );
}
