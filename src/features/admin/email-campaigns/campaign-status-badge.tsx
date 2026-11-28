import { Badge } from "@/components/ui/badge";
import { CAMPAIGN_STATUS_BADGE, CAMPAIGN_STATUS_LABEL, type CampaignStatus } from "@/lib/email-campaigns";

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge variant={CAMPAIGN_STATUS_BADGE[status]}>{CAMPAIGN_STATUS_LABEL[status]}</Badge>;
}

/** Dates are shown in the store's own time zone (Asia/Dhaka), like the other admin e-mail pages, and the zone is named wherever a schedule is shown. */
export const formatDhaka = (d: Date | string | null | undefined): string =>
  d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" }).format(new Date(d)) : "—";
