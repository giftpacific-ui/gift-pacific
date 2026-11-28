"use client";

import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendTemplateTestEmailAction } from "@/server/actions/admin-email-template.actions";

/** "Send test email": ONE message to the address typed here, with sample customer data. It is not a campaign and creates no consent or recipient. */
export function SendTestDialog({ source, disabled }: { source: { templateId: string } | { subject: string; design: unknown }; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setOutcome(null);
    start(async () => {
      const res = await sendTemplateTestEmailAction({ recipient: email, ...source });
      setOutcome({ ok: res.success, message: res.message });
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setOutcome(null); }}>
      <DialogTrigger asChild><Button type="button" variant="outline" disabled={disabled}><Send /> Send test email</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send test email</DialogTitle>
          <DialogDescription>Sends this template once, with sample customer data, to the address below only. It is not a campaign, it does not record consent and the unsubscribe link in it is a sample.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="tt-email">Send the test to</Label>
            <Input id="tt-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          {outcome && <p role={outcome.ok ? "status" : "alert"} className={`rounded-md border p-3 text-sm ${outcome.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{outcome.message}</p>}
          <Button type="submit" className="w-full" disabled={pending || !email.trim()}>{pending ? "Sending…" : "Send test email"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
