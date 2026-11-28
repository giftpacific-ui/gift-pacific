"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { checkSmtpConnectionAction, sendSmtpTestEmailAction } from "@/server/actions/admin-smtp.actions";
import type { SmtpActionResult, SmtpAdminStatus } from "@/server/services/admin-smtp.service";

type Feedback = (SmtpActionResult & { kind: "check" | "test"; at: Date }) | null;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 py-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-medium">{value}</dd>
    </div>
  );
}

/** Status comes from the server (environment only). "Connection" is what the admin last verified in this page session. */
export function SmtpSettingsPanel({ status, defaultRecipient }: { status: SmtpAdminStatus; defaultRecipient: string }) {
  const [recipient, setRecipient] = useState(defaultRecipient);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, start] = useTransition();
  const usable = status.state === "configured";

  const run = (kind: "check" | "test", fn: () => Promise<SmtpActionResult>) =>
    start(async () => {
      try {
        setFeedback({ ...(await fn()), kind, at: new Date() });
      } catch {
        // requireAdmin() throws FORBIDDEN (session expired / not an admin); anything else is a transport problem. Neither carries SMTP data.
        setFeedback({ success: false, code: "forbidden", message: "The request was refused. Sign in again as an administrator and retry.", kind, at: new Date() });
      }
    });

  const connection = feedback?.kind === "check" || feedback?.kind === "test" ? (feedback.success ? "ok" : feedback.code === "recipient_rejected" || feedback.code === "invalid_recipient" || feedback.code === "throttled" || feedback.code === "forbidden" ? "unknown" : "failed") : "unknown";
  const badge = !usable
    ? { text: status.state === "invalid" ? "Invalid settings" : "Not configured", variant: "secondary" as const }
    : connection === "ok" ? { text: "Connected", variant: "success" as const }
    : connection === "failed" ? { text: "Connection failed", variant: "destructive" as const }
    : { text: "Configured · not checked yet", variant: "secondary" as const };

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-lg font-semibold">E-mail (SMTP)</h3>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Read-only. The SMTP login and password are set in the server environment and are never shown here.</p>

      <dl className="mt-4 text-sm">
        <Row label="Sender name" value={status.senderName ?? "Not set"} />
        <Row label="Sender e-mail" value={status.senderEmail ?? "Not set"} />
        <Row label="Server" value={status.host ? `${status.host}:${status.port} (${status.encryption})` : "Not set"} />
        <Row label="Login" value={status.loginUser ?? "Not set"} />
        <Row label="Password" value={status.passwordSet ? "Set (hidden)" : "Not set"} />
      </dl>

      {status.state === "not_configured" && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">E-mail is off. Set SMTP_USER and SMTP_PASS (a Gmail App Password) on the server and restart. See .env.example.</p>
      )}
      {status.problems.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 rounded-lg bg-amber-50 p-3 pl-7 text-sm text-amber-900">
          {status.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {status.warnings.map((w) => <p key={w} className="mt-2 rounded-lg bg-muted p-3 text-sm">{w}</p>)}

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="smtp-test-recipient" className="text-xs text-muted-foreground">Send a test e-mail to</label>
          <Input id="smtp-test-recipient" type="email" inputMode="email" autoComplete="off" maxLength={254} placeholder="you@example.com" value={recipient} disabled={!usable || pending} onChange={(e) => setRecipient(e.target.value)} />
        </div>
        <Button type="button" disabled={!usable || pending || recipient.trim() === ""} onClick={() => run("test", () => sendSmtpTestEmailAction(recipient))}>
          {pending ? "Working…" : "Send test email"}
        </Button>
        <Button type="button" variant="outline" disabled={!usable || pending} onClick={() => run("check", checkSmtpConnectionAction)}>
          Check connection
        </Button>
      </div>

      <div aria-live="polite" className="mt-3">
        {feedback && (
          <p role={feedback.success ? "status" : "alert"} className={`rounded-lg p-3 text-sm ${feedback.success ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"}`}>
            <span className="font-medium">{feedback.success ? "Success: " : "Failed: "}</span>{feedback.message}
            {feedback.success && feedback.detail ? <span className="mt-1 block text-xs opacity-80">{feedback.detail}</span> : null}
            <span className="mt-1 block text-xs opacity-70">{feedback.kind === "test" ? "Test e-mail" : "Connection check"} · {feedback.at.toLocaleTimeString()}</span>
          </p>
        )}
      </div>
    </div>
  );
}
