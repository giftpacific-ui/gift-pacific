"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Loader2, Search, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmailPreview } from "@/features/admin/email-templates/email-preview";
import {
  getCampaignAudienceOverviewAction, getCampaignReviewAction, prepareCampaignAudienceAction, previewCampaignTemplateAction, saveCampaignDraftAction,
  searchAudienceContactsAction, sendCampaignNowAction, type PrepareAudienceOutcome,
} from "@/server/actions/admin-email-campaign.actions";
import { audienceAdditiveWarning, reasonLabel, type AudiencePool, type AudienceSummary, type CampaignReview, type CampaignTemplateChoice, type FieldError } from "@/lib/email-campaigns";
import { cn } from "@/lib/utils";

export type WizardInitial = {
  campaignId: string | null;
  details: { name: string; description: string; senderName: string; senderEmail: string };
  templateId: string | null;
  audience: AudienceSummary | null;
  step: number;
};

const STEPS = ["Details", "Template", "Audience", "Review & send"] as const;
const BASE = "/admin/email-marketing/campaigns";
const n = (v: number) => v.toLocaleString("en-US");
const errorsFor = (errors: FieldError[] | undefined, field: string) => errors?.filter((e) => e.field === field).map((e) => e.message) ?? [];

function FieldMessage({ id, messages }: { id: string; messages: string[] }) {
  return messages.length ? <p id={id} role="alert" className="mt-1 text-sm text-destructive">{messages[0]}</p> : null;
}
function ErrorBox({ message }: { message: string | null }) {
  return message ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{message}</p> : null;
}
/** Persistent (not dismissible) notice shown wherever a campaign already has recipient rows: audience preparation only ever ADDS contacts. */
function AudienceAdditiveNotice({ recipientRows }: { recipientRows: number }) {
  const warning = audienceAdditiveWarning(recipientRows);
  if (!warning) return null;
  return (
    <div role="note" aria-label="Audience warning" data-testid="audience-additive-warning" className="rounded-md border-2 border-amber-500 bg-amber-500/10 p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-5 shrink-0 text-amber-600" aria-hidden /> {warning.title}</p>
      <ul className="mt-2 list-inside list-disc space-y-1">{warning.points.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}
function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return <Card><CardContent className="p-4"><div className="text-xs uppercase text-muted-foreground">{label}</div><div className="text-2xl font-semibold">{typeof value === "number" ? n(value) : value}</div>{hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}</CardContent></Card>;
}

export function CampaignWizard({ initial, templates }: { initial: WizardInitial; templates: CampaignTemplateChoice[] }) {
  const router = useRouter();
  const [step, setStep] = useState(initial.step);
  const [campaignId, setCampaignId] = useState<string | null>(initial.campaignId);
  const [details, setDetails] = useState(initial.details);
  const [templateId, setTemplateId] = useState<string | null>(initial.templateId);
  const [audience, setAudience] = useState<AudienceSummary | null>(initial.audience);
  const [fieldErrors, setFieldErrors] = useState<FieldError[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false); // synchronous: two quick clicks can never start two requests (state updates are asynchronous)

  /** Runs one server request at a time. Returns undefined when another request is already running. */
  async function once<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (inFlight.current) return undefined;
    inFlight.current = true; setSaving(true); setError(null);
    try { return await fn(); } finally { inFlight.current = false; setSaving(false); }
  }

  // ---------------------------------------------------------------------------------------------------------------------------- step 1 + 2: save
  const detailsOk = details.name.trim().length > 0;

  function goDetailsNext() {
    const errs: FieldError[] = [];
    if (!details.name.trim()) errs.push({ field: "name", code: "required", message: "Enter a campaign name." });
    if (details.name.trim().length > 160) errs.push({ field: "name", code: "too_long", message: "The campaign name must be 160 characters or fewer." });
    if (details.senderEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.senderEmail.trim())) errs.push({ field: "senderEmail", code: "invalid_email", message: "Enter a valid sender e-mail address, or leave it empty." });
    setFieldErrors(errs.length ? errs : undefined);
    if (!errs.length) setStep(2);
  }

  async function saveAndContinue() {
    if (!templateId) { setError("Choose a template."); return; }
    const res = await once(() => saveCampaignDraftAction({ campaignId, ...details, templateId }));
    if (!res) return;
    if (!res.success) {
      setFieldErrors(res.errors);
      // A field problem belongs to step 1 (name, sender); a template problem stays on this step.
      if (res.errors?.some((e) => ["name", "description", "senderName", "senderEmail"].includes(e.field))) setStep(1);
      setError(res.message);
      return;
    }
    setFieldErrors(undefined);
    setCampaignId(res.id);
    toast.success(res.created ? "Draft saved." : "Draft updated.");
    setStep(3);
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Campaign steps">
        <ol className="grid grid-cols-4 gap-1 text-center text-xs sm:text-sm">
          {STEPS.map((label, i) => {
            const num = i + 1;
            const state = num < step ? "done" : num === step ? "current" : "todo";
            return (
              <li key={label} aria-current={state === "current" ? "step" : undefined} className={cn("rounded-md border px-1 py-2", state === "current" && "border-primary bg-primary text-primary-foreground", state === "done" && "border-primary/40 bg-primary/10", state === "todo" && "text-muted-foreground")}>
                <span className="block font-semibold">{state === "done" ? <Check className="mx-auto size-4" aria-label="Completed" /> : num}</span><span className="hidden sm:block">{label}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      <ErrorBox message={error} />

      {step === 1 && (
        <section aria-labelledby="step1" className="space-y-4">
          <h2 id="step1" className="font-heading text-xl">Campaign details</h2>
          <div>
            <Label htmlFor="c-name">Campaign name *</Label>
            <Input id="c-name" value={details.name} maxLength={160} aria-required="true" aria-invalid={errorsFor(fieldErrors, "name").length > 0} aria-describedby="c-name-err" onChange={(e) => setDetails({ ...details, name: e.target.value })} />
            <FieldMessage id="c-name-err" messages={errorsFor(fieldErrors, "name")} />
          </div>
          <div>
            <Label htmlFor="c-desc">Description (optional)</Label>
            <Textarea id="c-desc" value={details.description} maxLength={1000} rows={3} onChange={(e) => setDetails({ ...details, description: e.target.value })} />
            <FieldMessage id="c-desc-err" messages={errorsFor(fieldErrors, "description")} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="c-sname">Sender name</Label>
              <Input id="c-sname" value={details.senderName} maxLength={100} aria-describedby="c-sname-err" onChange={(e) => setDetails({ ...details, senderName: e.target.value })} />
              <FieldMessage id="c-sname-err" messages={errorsFor(fieldErrors, "senderName")} />
            </div>
            <div>
              <Label htmlFor="c-semail">Sender e-mail</Label>
              <Input id="c-semail" type="email" value={details.senderEmail} aria-describedby="c-semail-err" onChange={(e) => setDetails({ ...details, senderEmail: e.target.value })} />
              <FieldMessage id="c-semail-err" messages={errorsFor(fieldErrors, "senderEmail")} />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Leave the sender empty to use the store&apos;s configured e-mail sender.</p>
          <div className="flex justify-end"><Button type="button" disabled={!detailsOk} onClick={goDetailsNext}>Next: template <ArrowRight /></Button></div>
        </section>
      )}

      {step === 2 && <TemplateStep templates={templates} templateId={templateId} setTemplateId={setTemplateId} saving={saving} onBack={() => setStep(1)} onNext={saveAndContinue} />}

      {step === 3 && campaignId && (
        <AudienceStep campaignId={campaignId} audience={audience} setAudience={setAudience} once={once} saving={saving} setError={setError} onBack={() => setStep(2)} onNext={() => setStep(4)} />
      )}

      {step === 4 && campaignId && (
        <ReviewAndSend campaignId={campaignId} once={once} saving={saving} setError={setError} onBack={() => setStep(3)}
          onSent={(id, message) => { toast.success(message); router.push(`${BASE}/${id}`); router.refresh(); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------ step 2

function TemplateStep({ templates, templateId, setTemplateId, saving, onBack, onNext }: {
  templates: CampaignTemplateChoice[]; templateId: string | null; setTemplateId: (id: string) => void; saving: boolean; onBack: () => void; onNext: () => void;
}) {
  const [preview, setPreview] = useState<{ id: string; subject: string | null; html: string | null; error: string | null; loading: boolean } | null>(null);
  const previewSeq = useRef(0);

  async function showPreview(id: string) {
    const seq = ++previewSeq.current;
    setPreview({ id, subject: null, html: null, error: null, loading: true });
    const res = await previewCampaignTemplateAction(id); // the existing template preview: designer marker removed, sample customer data
    if (seq !== previewSeq.current) return; // a newer preview was requested meanwhile
    setPreview(res.success ? { id, subject: res.subject, html: res.html, error: null, loading: false } : { id, subject: null, html: null, error: res.message, loading: false });
  }

  const chosen = templates.find((t) => t.id === templateId);
  return (
    <section aria-labelledby="step2" className="space-y-4">
      <h2 id="step2" className="font-heading text-xl">Choose an e-mail template</h2>
      <p className="text-sm text-muted-foreground">The campaign keeps its own copy of the template, so later template edits never change it. Draft designer templates cannot be used until they are marked ready.</p>
      {templates.length === 0 && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">There are no templates yet. Create one under Templates first.</p>}
      <div role="radiogroup" aria-label="Template" className="grid gap-3 md:grid-cols-2">
        {templates.map((t) => {
          const selected = t.id === templateId;
          return (
            <div key={t.id} className={cn("rounded-md border p-3", selected && "border-primary ring-1 ring-primary", !t.eligible && "bg-muted/40")}>
              <div className="flex items-start justify-between gap-2">
                <label className={cn("flex min-w-0 flex-1 items-start gap-2", t.eligible ? "cursor-pointer" : "cursor-not-allowed")}>
                  <input type="radio" name="template" className="mt-1" checked={selected} disabled={!t.eligible || saving} onChange={() => { setTemplateId(t.id); void showPreview(t.id); }} aria-describedby={`t-${t.id}-meta`} />
                  <span className="min-w-0"><span className="block truncate font-medium">{t.name}</span><span className="block truncate text-xs text-muted-foreground">{t.subject}</span></span>
                </label>
                <Badge variant={t.kind === "draft" ? "secondary" : t.kind === "ready" ? "success" : "outline"}>{t.kind === "draft" ? "Draft" : t.kind === "ready" ? "Ready" : "Standard"}</Badge>
              </div>
              <div id={`t-${t.id}-meta`} className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{t.category.charAt(0) + t.category.slice(1).toLowerCase()}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => void showPreview(t.id)}>Preview</Button>
              </div>
              {!t.eligible && t.reason && <p className="mt-2 flex items-start gap-1 text-xs text-destructive"><AlertTriangle className="mt-0.5 size-3 shrink-0" /> {t.reason}</p>}
            </div>
          );
        })}
      </div>
      {preview && <EmailPreview html={preview.html} subject={preview.subject} error={preview.error} loading={preview.loading} />}
      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}><ArrowLeft /> Back</Button>
        <Button type="button" disabled={!chosen || !chosen.eligible || saving} onClick={onNext}>{saving ? <Loader2 className="animate-spin" /> : null} Save and continue <ArrowRight /></Button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------ step 3

type Once = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function AudienceStep({ campaignId, audience, setAudience, once, saving, setError, onBack, onNext }: {
  campaignId: string; audience: AudienceSummary | null; setAudience: (a: AudienceSummary) => void; once: Once; saving: boolean; setError: (m: string | null) => void; onBack: () => void; onNext: () => void;
}) {
  const [pool, setPool] = useState<AudiencePool | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; email: string; name: string | null; eligible: boolean }[]>([]);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [run, setRun] = useState<PrepareAudienceOutcome["run"] | null>(null);

  useEffect(() => {
    let live = true;
    void getCampaignAudienceOverviewAction(campaignId).then((res) => {
      if (!live) return;
      setLoading(false);
      if (res.success) { setPool(res.pool); setAudience(res.audience); } else setError(res.message);
    });
    return () => { live = false; };
  }, [campaignId, setAudience, setError]);

  const search = useCallback(async () => {
    const res = await once(() => searchAudienceContactsAction(query));
    if (res?.success) setFound(res.contacts); else if (res) setError(res.message);
  }, [once, query, setError]);

  async function prepare() {
    if (mode === "selected" && picked.size === 0) { setError("Choose at least one contact, or use all contacts."); return; }
    const res = await once(() => prepareCampaignAudienceAction(campaignId, mode === "selected" ? { contactIds: [...picked.keys()] } : {}));
    if (!res) return;
    if (!res.success) { setError(res.message); return; }
    setAudience(res.audience); setRun(res.run);
    toast.success("Audience prepared.");
  }

  const excluded = run ? Object.entries(run.excluded).filter(([, c]) => c > 0) : [];
  return (
    <section aria-labelledby="step3" className="space-y-4">
      <h2 id="step3" className="font-heading text-xl">Audience</h2>
      <p className="text-sm text-muted-foreground">
        Only contacts with a valid marketing consent and no suppression can receive a campaign. Eligibility is decided by the store&apos;s existing marketing rules, not by this page, and is checked again when the e-mail is due.
        Checkout progress consent is never treated as marketing consent.
      </p>

      <AudienceAdditiveNotice recipientRows={audience?.total ?? 0} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy={loading}>
        <Stat label="Contacts" value={pool ? pool.total : "…"} />
        <Stat label="Eligible now" value={pool ? pool.eligible : "…"} hint={pool && !pool.eligibleChecked ? "Estimate (large list)" : undefined} />
        <Stat label="Unsubscribed" value={pool ? pool.unsubscribed : "…"} hint="Never mailed" />
        <Stat label="Suppressed / inactive" value={pool ? `${n(pool.suppressed)} / ${n(pool.inactive)}` : "…"} hint="Bounced, complained, blocked, inactive" />
      </div>

      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Who should receive this campaign?</legend>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="aud" className="mt-1" checked={mode === "all"} onChange={() => setMode("all")} /><span><span className="font-medium">All eligible contacts</span><span className="block text-muted-foreground">Every active contact is checked; only eligible ones are added.</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="aud" className="mt-1" checked={mode === "selected"} onChange={() => setMode("selected")} /><span><span className="font-medium">Selected contacts</span><span className="block text-muted-foreground">Pick specific contacts; each is still checked.</span></span></label>
        {mode === "selected" && (
          <div className="space-y-2 pl-6">
            <div className="flex gap-2">
              <Input value={query} maxLength={100} placeholder="Search name or e-mail" aria-label="Search contacts" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} />
              <Button type="button" variant="outline" onClick={() => void search()} disabled={saving}><Search /> Search</Button>
            </div>
            <ul className="max-h-52 space-y-1 overflow-auto text-sm">
              {found.length === 0 && <li className="text-muted-foreground">Search to list contacts that have given consent.</li>}
              {found.map((c) => (
                <li key={c.id}><label className="flex items-center gap-2"><input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((prev) => { const next = new Map(prev); if (e.target.checked) next.set(c.id, c.email); else next.delete(c.id); return next; })} /><span className="truncate">{c.email}{c.name ? ` · ${c.name}` : ""}</span>{!c.eligible && <Badge variant="outline">Not eligible</Badge>}</label></li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground" aria-live="polite">{picked.size} selected</p>
          </div>
        )}
        <Button type="button" onClick={() => void prepare()} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : null} {audience && audience.total > 0 ? "Re-check and add eligible contacts" : "Prepare audience"}</Button>
        <p className="text-xs text-muted-foreground">The audience is a snapshot of eligible contacts. Running this again re-checks everyone already in it (anyone who is no longer eligible is skipped) and adds newly eligible contacts from your choice.</p>
      </fieldset>

      {run && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-live="polite">
          <p className="font-medium">Last run: {n(run.added)} added, {n(run.alreadyPrepared)} already in the audience{run.skippedNow ? `, ${n(run.skippedNow)} newly skipped` : ""}.</p>
          {excluded.length > 0 && <ul className="mt-1 list-inside list-disc text-muted-foreground">{excluded.map(([code, c]) => <li key={code}>{n(c)} not added: {reasonLabel(code)}</li>)}</ul>}
        </div>
      )}

      {audience && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Eligible recipients" value={audience.eligible} hint="Will be re-checked when sent" />
          <Stat label="Skipped" value={audience.skipped} hint={audience.skipReasons.map((r) => `${n(r.count)} ${reasonLabel(r.code)}`).join("; ") || undefined} />
          <Stat label="In audience" value={audience.total} />
        </div>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}><ArrowLeft /> Back</Button>
        <Button type="button" disabled={saving || !audience || audience.eligible < 1} onClick={onNext}>Next: review <ArrowRight /></Button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------ step 4

function ReviewAndSend({ campaignId, once, saving, setError, onBack, onSent }: {
  campaignId: string; once: Once; saving: boolean; setError: (m: string | null) => void; onBack: () => void; onSent: (id: string, message: string) => void;
}) {
  const [review, setReview] = useState<CampaignReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void getCampaignReviewAction(campaignId).then((res) => {
      if (!live) return;
      setLoading(false);
      if (res.success) setReview(res.review); else setError(res.message);
    });
    return () => { live = false; };
  }, [campaignId, setError]);

  async function send() {
    setSendError(null);
    if (!review?.ready) return;
    if (!confirm(`Send "${review.campaign.name}" now?\n\nIt is sent immediately to up to ${n(review.audience.eligible)} recipient(s). Everyone is checked again for valid marketing consent and suppression at the moment of sending, and anyone no longer eligible is skipped. This cannot be undone.`)) return;
    const res = await once(() => sendCampaignNowAction(campaignId));
    if (!res) return;
    if (!res.success) { setSendError(res.errors?.[0]?.message ?? res.message); return; }
    setDone(true); // stays disabled: the campaign has left the draft state, a repeat would only be refused
    onSent(res.id, res.message);
  }

  if (loading || !review) return <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground" aria-busy="true">Preparing the review…</p>;
  const c = review.campaign;

  return (
    <section aria-labelledby="step4" className="space-y-4">
      <h2 id="step4" className="font-heading text-xl">Review and send</h2>
      <AudienceAdditiveNotice recipientRows={review.audience.total} />
      <div className="grid gap-3 md:grid-cols-2">
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <div className="text-xs uppercase text-muted-foreground">Campaign</div>
          <div className="font-medium">{c.name}</div>{c.description && <div className="text-muted-foreground">{c.description}</div>}
          <div>Template: {c.templateName ?? "—"}</div>
          <div>Sender: {c.senderName || c.senderEmail ? `${c.senderName ?? ""} ${c.senderEmail ? `<${c.senderEmail}>` : ""}`.trim() : "Store default sender"}</div>
        </CardContent></Card>
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <div className="text-xs uppercase text-muted-foreground">Audience</div>
          <div><span className="text-2xl font-semibold">{n(review.audience.eligible)}</span> eligible recipients</div>
          <div className="text-muted-foreground">{n(review.audience.skipped)} skipped, {n(review.audience.total)} in the audience</div>
          <div className="text-xs text-muted-foreground">Everyone is re-checked for consent and suppression when the e-mail is sent.</div>
        </CardContent></Card>
      </div>
      <ul className="space-y-1 text-sm" aria-label="Final checks">
        {review.checks.map((k) => (
          <li key={k.id} className="flex items-start gap-2">
            {k.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" aria-label="Passed" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />}
            <span>{k.label}{k.detail && <span className="block text-destructive">{k.detail}</span>}</span>
          </li>
        ))}
      </ul>
      <EmailPreview html={review.html} subject={review.subject} />
      <p className="text-xs text-muted-foreground">This is the customer-facing message with sample data. Each real recipient gets their own unsubscribe link.</p>
      {!review.ready && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">The campaign is not ready to send. Fix the failed check above first.</p>}
      {sendError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{sendError}</p>}
      <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        Sending starts right away: the e-mails are queued now and the store&apos;s e-mail worker delivers them within its hourly and daily limits, so delivery can take a little while. Only contacts with a valid marketing consent
        and no suppression receive it. Once sent it cannot be recalled; you can still cancel the e-mails that have not gone out yet from the campaign page.
      </p>
      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving || done}><ArrowLeft /> Back</Button>
        <Button type="button" disabled={!review.ready || saving || done} onClick={() => void send()}>{saving ? <Loader2 className="animate-spin" /> : <Send />} Send campaign now</Button>
      </div>
    </section>
  );
}
