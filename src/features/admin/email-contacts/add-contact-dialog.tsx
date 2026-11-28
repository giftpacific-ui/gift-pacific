"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createEmailContactAction } from "@/server/actions/admin-email-contact.actions";
import { MIN_CONSENT_EVIDENCE_LENGTH } from "@/lib/email-contacts";

type Outcome = { ok: boolean; message: string; field?: string; contactId?: string };

export function AddContactDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [grant, setGrant] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function reset() { setEmail(""); setName(""); setGrant(false); setEvidence(""); setOutcome(null); }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setOutcome(null);
    start(async () => {
      const res = await createEmailContactAction({ email, name, grantConsent: grant, consentEvidence: grant ? evidence : undefined });
      if (res.success) {
        setOutcome({ ok: true, message: res.message, contactId: res.contactId });
        toast.success(res.created ? "Contact added." : "Contact already existed.");
        setEmail(""); setName(""); setGrant(false); setEvidence("");
        router.refresh();
      } else {
        setOutcome({ ok: false, message: res.message, field: res.field });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild><Button type="button"><Plus /> Add contact</Button></DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>Adding a contact does not give it marketing consent. Only tick the box below if the person has explicitly agreed to receive marketing e-mail, and say how.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="ec-email">Email address</Label>
            <Input id="ec-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={outcome?.field === "email"} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ec-name">Name (optional)</Label>
            <Input id="ec-name" autoComplete="off" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={outcome?.field === "name"} />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="ec-consent" checked={grant} onCheckedChange={(v) => setGrant(v === true)} className="mt-0.5" />
            <Label htmlFor="ec-consent" className="font-normal leading-snug">This person has explicitly agreed to receive marketing e-mail from us.</Label>
          </div>
          {grant && (
            <div className="space-y-1.5">
              <Label htmlFor="ec-evidence">Consent evidence (required)</Label>
              <Textarea id="ec-evidence" value={evidence} maxLength={500} onChange={(e) => setEvidence(e.target.value)} aria-invalid={outcome?.field === "consentEvidence"}
                placeholder="How and when they agreed, e.g. signed paper form at the 12 Oct pop-up" />
              <p className="text-xs text-muted-foreground">At least {MIN_CONSENT_EVIDENCE_LENGTH} characters, up to 500. Stored with the consent record.</p>
            </div>
          )}
          {outcome && (
            <p role={outcome.ok ? "status" : "alert"} className={`rounded-md border p-3 text-sm ${outcome.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{outcome.message}</p>
          )}
          {outcome?.ok && outcome.contactId && (
            <p className="text-sm"><Link className="underline" href={`/admin/email-marketing/contacts/${outcome.contactId}`}>View this contact and manage its marketing consent</Link></p>
          )}
          <Button type="submit" className="w-full" disabled={pending || !email.trim()}>{pending ? "Saving…" : "Add contact"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
