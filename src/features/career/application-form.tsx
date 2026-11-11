"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { applyToJobAction } from "@/server/actions/career.actions";

type Question = { id: string; label: string; kind: string; options: string[]; isRequired: boolean };

export function ApplicationForm({ slug, questions }: { slug: string; questions: Question[] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.id] = String(fd.get(`q_${q.id}`) ?? "");
    start(async () => {
      const result = await applyToJobAction(slug, {
        name: fd.get("name"),
        email: fd.get("email"),
        phone: fd.get("phone"),
        coverNote: fd.get("coverNote"),
        portfolioUrl: fd.get("portfolioUrl"),
        consent: fd.get("consent") === "on",
        website: fd.get("website"),
        answers,
      });
      if (result.success) setDone(true);
      else setMessage({ ok: false, text: result.message });
    });
  }

  if (done) {
    return (
      <p role="status" className="rounded-[4px] bg-secondary p-4 text-sm">
        Thank you — your application has been received. We will contact you if we would like to talk further.
      </p>
    );
  }

  const field = "grid gap-1.5 text-sm font-medium";
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <label className={field}>Full name *<Input name="name" required maxLength={100} autoComplete="name" /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={field}>Email *<Input name="email" type="email" required maxLength={200} autoComplete="email" /></label>
        <label className={field}>Phone<Input name="phone" type="tel" maxLength={30} autoComplete="tel" /></label>
      </div>
      <label className={field}>Portfolio or CV link (optional)<Input name="portfolioUrl" type="url" placeholder="https://" maxLength={500} /></label>
      <label className={field}>Cover note<Textarea name="coverNote" rows={5} maxLength={3000} /></label>

      {questions.map((q) => (
        <label key={q.id} className={field}>
          {q.label}{q.isRequired ? " *" : ""}
          {q.kind === "TEXTAREA" ? (
            <Textarea name={`q_${q.id}`} rows={4} maxLength={2000} />
          ) : q.kind === "SELECT" || q.kind === "YES_NO" ? (
            <select name={`q_${q.id}`} defaultValue="" className="h-10 rounded-[4px] border border-input bg-background px-3 text-sm font-normal">
              <option value="">Select…</option>
              {(q.kind === "YES_NO" ? ["Yes", "No"] : q.options).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <Input name={`q_${q.id}`} maxLength={2000} />
          )}
        </label>
      ))}

      {/* Honeypot: hidden from people and assistive tech; bots tend to fill it. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>

      <label className="flex items-start gap-2 text-sm font-normal">
        <input type="checkbox" name="consent" className="mt-1" required />
        <span>I agree that {`this business`} may store my application and contact me about this position. *</span>
      </label>
      {message && <p role="alert" className="text-sm text-destructive">{message.text}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send application"}</Button>
    </form>
  );
}
