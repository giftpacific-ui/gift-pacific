"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { recordEmailContactConsentAction, withdrawEmailContactConsentAction } from "@/server/actions/admin-email-contact.actions";
import { MIN_CONSENT_EVIDENCE_LENGTH } from "@/lib/email-contacts";

/**
 * Marketing consent controls on a contact's page. WHICH controls show is only a convenience (grant when no consent is open, withdraw when one is); the
 * server decides everything: it requires the evidence and the attestation, records the time itself, refuses any suppressed or inactive contact and never lifts
 * a suppression. Nothing here sends mail. Consent history is append-only: these buttons add a record or end the open one, they never edit or delete.
 */
export function ContactConsentPanel({ contactId, hasOpenConsent, suppressed, isActive }: { contactId: string; hasOpenConsent: boolean; suppressed: boolean; isActive: boolean }) {
  const router = useRouter();
  const [evidence, setEvidence] = useState("");
  const [attest, setAttest] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string; field?: string } | null>(null);
  const [pending, start] = useTransition();
  const busy = useRef(false); // a second click while a request runs must not send a second request

  function run(fn: () => Promise<{ success: boolean; message: string; field?: string }>, after: () => void) {
    if (busy.current) return;
    busy.current = true;
    setMessage(null);
    start(async () => {
      try {
        const res = await fn();
        setMessage({ ok: res.success, text: res.message, field: res.success ? undefined : res.field });
        if (res.success) { toast.success(res.message); after(); }
        router.refresh();
      } finally { busy.current = false; }
    });
  }

  const record = () => run(() => recordEmailContactConsentAction(contactId, { evidence, attest }), () => { setEvidence(""); setAttest(false); });
  const withdraw = () => {
    if (!confirm("Record that this person has withdrawn marketing consent? They will stop receiving marketing e-mail. The earlier consent stays in the history.")) return;
    run(() => withdrawEmailContactConsentAction(contactId, { note }), () => setNote(""));
  };

  return (
    <div className="space-y-4">
      {!hasOpenConsent && (
        <div className="space-y-3">
          {suppressed && <p role="note" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">This address is suppressed. Consent cannot be recorded here, and a suppression cannot be lifted from this page.</p>}
          {!suppressed && !isActive && <p role="note" className="rounded-md border bg-muted/30 p-3 text-sm">This contact is inactive. Activate it before recording consent.</p>}
          <p className="text-sm text-muted-foreground">Only record consent the person gave explicitly. Creating an account, ordering, saving a cart or checking out is never marketing consent.</p>
          <div className="space-y-1.5">
            <Label htmlFor="cc-evidence">Consent evidence (required)</Label>
            <Textarea id="cc-evidence" value={evidence} maxLength={500} rows={3} onChange={(e) => setEvidence(e.target.value)} aria-invalid={message?.field === "evidence"}
              placeholder="How and when they agreed, e.g. signed paper form at the 12 Oct pop-up" />
            <p className="text-xs text-muted-foreground">At least {MIN_CONSENT_EVIDENCE_LENGTH} characters, up to 500. The time of recording is saved automatically, so say in the evidence when the person agreed.</p>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="cc-attest" checked={attest} onCheckedChange={(v) => setAttest(v === true)} className="mt-0.5" aria-invalid={message?.field === "attest"} />
            <Label htmlFor="cc-attest" className="font-normal leading-snug">I hold the evidence that this person explicitly agreed to receive marketing e-mail from us.</Label>
          </div>
          <Button type="button" disabled={pending || suppressed || !isActive || !attest || evidence.trim().length < MIN_CONSENT_EVIDENCE_LENGTH} onClick={record}>{pending ? "Saving…" : "Record consent"}</Button>
        </div>
      )}
      {hasOpenConsent && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Use this when the person tells you they no longer want marketing e-mail. It ends the current consent right away; the record stays in the history.</p>
          <div className="space-y-1.5">
            <Label htmlFor="cc-note">Note (optional)</Label>
            <Textarea id="cc-note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} aria-invalid={message?.field === "note"} placeholder="How the person asked, e.g. replied to a campaign by e-mail" />
          </div>
          <Button type="button" variant="outline" disabled={pending} onClick={withdraw}>{pending ? "Saving…" : "Record consent withdrawal"}</Button>
        </div>
      )}
      {message && <p role={message.ok ? "status" : "alert"} className={`rounded-md border p-3 text-sm ${message.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{message.text}</p>}
    </div>
  );
}
