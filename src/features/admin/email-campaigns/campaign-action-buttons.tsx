"use client";

import { useRef, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, Pencil, PlayCircle, Send, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelCampaignAction, continueCampaignSendingAction, sendCampaignNowAction, unscheduleCampaignAction } from "@/server/actions/admin-email-campaign.actions";
import type { CampaignAction, CampaignStatus } from "@/lib/email-campaigns";

const BASE = "/admin/email-marketing/campaigns";

/**
 * The actions a campaign offers in its current status. WHICH ones is decided by campaignActionsFor (derived from the existing transition rules) and
 * passed in; the server still refuses anything the lifecycle does not allow. "Send now" calls a server action that hands the draft to the existing dispatcher;
 * this component never talks to SMTP or the queue.
 */
export function CampaignActionButtons({ id, name, status, actions, showView = true }: { id: string; name: string; status: CampaignStatus; actions: CampaignAction[]; showView?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const busy = useRef(false); // a second click while a request is running must not send a second request

  function run(fn: () => Promise<{ success: boolean; message?: string }>, done: string | ((res: { success: boolean; message?: string }) => string)) {
    if (busy.current) return;
    busy.current = true;
    start(async () => {
      try {
        const res = await fn();
        if (res.success) { toast.success(typeof done === "function" ? done(res) : done); router.refresh(); } else toast.error(res.message ?? "The change could not be made.");
      } finally { busy.current = false; }
    });
  }

  return (
    <div className="flex flex-wrap justify-end gap-1">
      {showView && <Button asChild size="sm" variant="outline"><Link href={`${BASE}/${id}`}><Eye /> View</Link></Button>}
      {actions.includes("edit_draft") && <Button asChild size="sm" variant="outline"><Link href={`${BASE}/new?campaign=${id}`}><Pencil /> Continue editing</Link></Button>}
      {actions.includes("send_now") && (
        <Button type="button" size="sm" disabled={pending}
          onClick={() => { if (confirm(`Send "${name}" now?\n\nRecipients who are still eligible (valid marketing consent, not suppressed) are queued, and one batch is sent right now while this page waits. If the campaign is larger than one batch, the rest stays Pending until you click "Continue sending". Nothing is sent in the background. This cannot be undone.`)) run(() => sendCampaignNowAction(id), (res) => res.message ?? "Campaign sent to the e-mail queue."); }}>
          <Send /> Send now
        </Button>
      )}
      {status === "SENDING" && (
        <Button type="button" size="sm" disabled={pending}
          onClick={() => { if (confirm(`Continue sending "${name}"?\n\nThis queues recipients that are not queued yet and sends one more batch now, while this page waits. Everyone is checked again for consent and suppression.`)) run(() => continueCampaignSendingAction(id), (res) => res.message ?? "Batch processed."); }}>
          <PlayCircle /> Continue sending
        </Button>
      )}
      {actions.includes("unschedule") && (
        <Button type="button" size="sm" variant="outline" disabled={pending}
          onClick={() => { if (confirm(`Move "${name}" back to draft? It will not be sent automatically; you can send it from the draft.`)) run(() => unscheduleCampaignAction(id), "Campaign moved back to draft."); }}>
          <Undo2 /> Unschedule
        </Button>
      )}
      {actions.includes("cancel") && (
        <Button type="button" size="sm" variant="outline" disabled={pending}
          onClick={() => {
            const warn = status === "SENDING" ? " E-mails already sent cannot be recalled; e-mails still waiting will not be sent." : "";
            if (confirm(`Cancel "${name}"? A cancelled campaign cannot be restarted.${warn}`)) run(() => cancelCampaignAction(id), "Campaign cancelled.");
          }}>
          <XCircle /> Cancel campaign
        </Button>
      )}
    </div>
  );
}
