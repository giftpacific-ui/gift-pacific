"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  deleteApplicationAction,
  deleteJobAction,
  deleteQuestionAction,
  saveJobAction,
  saveQuestionAction,
  updateApplicationAction,
} from "@/server/actions/admin-team-career.actions";

export type JobRow = {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  description: string;
  requirements: string | null;
  status: "DRAFT" | "PUBLISHED" | "CLOSED";
  closesAt: string | null;
};
export type QuestionRow = { id: string; label: string; kind: string; options: string[]; isRequired: boolean; sortOrder: number };
export type ApplicationRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  coverNote: string | null;
  portfolioUrl: string | null;
  status: string;
  adminNote: string | null;
  createdAt: string;
  answers: { id: string; questionLabel: string; value: string }[];
};

const label = "grid gap-1.5 text-sm font-medium";
const selectCls = "h-10 rounded-md border border-input bg-background px-3 text-sm";

export function JobForm({ job }: { job: JobRow | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({
    title: job?.title ?? "", department: job?.department ?? "", location: job?.location ?? "", employmentType: job?.employmentType ?? "",
    description: job?.description ?? "", requirements: job?.requirements ?? "", status: job?.status ?? "DRAFT", closesAt: job?.closesAt?.slice(0, 10) ?? "",
  });
  function save() {
    start(async () => {
      const r = await saveJobAction(job?.id ?? null, f);
      if (!r.success) return void toast.error(r.message);
      toast.success("Saved");
      if (!job && r.id) router.push(`/admin/careers/${r.id}`);
      else router.refresh();
    });
  }
  function remove() {
    if (!job || !confirm("Delete this job?")) return;
    start(async () => {
      const r = await deleteJobAction(job.id);
      if (!r.success) return void toast.error(r.message);
      router.push("/admin/careers");
    });
  }
  return (
    <div className="grid gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-2">
      <label className={`${label} sm:col-span-2`}>Job title<Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} /></label>
      <label className={label}>Department<Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} maxLength={80} /></label>
      <label className={label}>Location<Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={80} /></label>
      <label className={label}>Employment type<Input value={f.employmentType} placeholder="Full-time, Part-time…" onChange={(e) => setF({ ...f, employmentType: e.target.value })} maxLength={60} /></label>
      <label className={label}>Apply by (optional)<Input type="date" value={f.closesAt} onChange={(e) => setF({ ...f, closesAt: e.target.value })} /></label>
      <label className={`${label} sm:col-span-2`}>Description (plain text)<Textarea rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={8000} /></label>
      <label className={`${label} sm:col-span-2`}>Requirements (plain text)<Textarea rows={4} value={f.requirements} onChange={(e) => setF({ ...f, requirements: e.target.value })} maxLength={4000} /></label>
      <label className={label}>Status
        <select className={selectCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as JobRow["status"] })}>
          <option value="DRAFT">Draft (not public)</option>
          <option value="PUBLISHED">Published</option>
          <option value="CLOSED">Closed</option>
        </select>
      </label>
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save job"}</Button>
        {job && <Button variant="outline" onClick={remove} disabled={pending}>Delete</Button>}
      </div>
    </div>
  );
}

export function QuestionManager({ jobId, questions }: { jobId: string; questions: QuestionRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState({ label: "", kind: "TEXT", options: "", isRequired: false });
  function add() {
    start(async () => {
      const r = await saveQuestionAction(jobId, null, {
        label: q.label, kind: q.kind as "TEXT", options: q.options.split(",").map((o) => o.trim()).filter(Boolean), isRequired: q.isRequired, sortOrder: questions.length,
      });
      if (!r.success) return void toast.error(r.message);
      setQ({ label: "", kind: "TEXT", options: "", isRequired: false });
      router.refresh();
    });
  }
  function remove(id: string) {
    start(async () => { await deleteQuestionAction(jobId, id); router.refresh(); });
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Applicants always give name, email, phone, cover note and a link. Add extra questions here if you need more.</p>
      <ul className="space-y-2">
        {questions.map((x) => (
          <li key={x.id} className="flex items-center justify-between rounded-lg border border-border/70 p-3 text-sm">
            <span>{x.label} <span className="text-muted-foreground">({x.kind.toLowerCase().replace("_", "/")}{x.isRequired ? ", required" : ""}{x.options.length ? `: ${x.options.join(", ")}` : ""})</span></span>
            <button type="button" aria-label="Delete question" disabled={pending} onClick={() => remove(x.id)}><Trash2 className="size-4 text-destructive" /></button>
          </li>
        ))}
      </ul>
      <div className="grid gap-3 rounded-lg border border-dashed border-border p-4 sm:grid-cols-2">
        <label className={`${label} sm:col-span-2`}>Question<Input value={q.label} onChange={(e) => setQ({ ...q, label: e.target.value })} maxLength={150} /></label>
        <label className={label}>Answer type
          <select className={selectCls} value={q.kind} onChange={(e) => setQ({ ...q, kind: e.target.value })}>
            <option value="TEXT">Short text</option><option value="TEXTAREA">Long text</option><option value="SELECT">Choose one</option><option value="YES_NO">Yes / No</option>
          </select>
        </label>
        {q.kind === "SELECT" && <label className={label}>Options (comma separated)<Input value={q.options} onChange={(e) => setQ({ ...q, options: e.target.value })} /></label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={q.isRequired} onChange={(e) => setQ({ ...q, isRequired: e.target.checked })} /> Required</label>
        <div><Button type="button" onClick={add} disabled={pending || !q.label.trim()}>Add question</Button></div>
      </div>
    </div>
  );
}

const STATUSES = ["NEW", "REVIEWING", "SHORTLISTED", "INTERVIEW", "REJECTED", "HIRED"];

export function ApplicationList({ jobId, applications }: { jobId: string; applications: ApplicationRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (applications.length === 0) return <p className="text-sm text-muted-foreground">No applications yet.</p>;
  const update = (id: string, data: { status?: string; adminNote?: string | null }) =>
    start(async () => {
      const r = await updateApplicationAction(id, data, jobId);
      if (!r.success) toast.error(r.message);
      else toast.success("Updated");
      router.refresh();
    });
  return (
    <ul className="space-y-4">
      {applications.map((a) => (
        <li key={a.id} className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-medium">{a.name}</p>
              <p className="text-sm text-muted-foreground"><a className="underline" href={`mailto:${a.email}`}>{a.email}</a>{a.phone ? ` · ${a.phone}` : ""}</p>
              <p className="text-xs text-muted-foreground">Applied {new Date(a.createdAt).toLocaleString("en-GB")}</p>
            </div>
            <select aria-label={`Status of ${a.name}`} className={selectCls} value={a.status} disabled={pending} onChange={(e) => update(a.id, { status: e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
            </select>
          </div>
          {a.portfolioUrl && <p className="text-sm"><a className="underline" href={a.portfolioUrl} target="_blank" rel="noopener noreferrer nofollow">Portfolio / CV link</a></p>}
          {a.coverNote && <p className="whitespace-pre-line text-sm text-muted-foreground">{a.coverNote}</p>}
          {a.answers.map((x) => <p key={x.id} className="text-sm"><span className="font-medium">{x.questionLabel}:</span> {x.value}</p>)}
          <div className="flex flex-wrap items-end gap-2">
            <label className={`${label} min-w-64 flex-1`}>Private note
              <Input value={notes[a.id] ?? a.adminNote ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} maxLength={2000} />
            </label>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => update(a.id, { adminNote: notes[a.id] ?? a.adminNote ?? "" })}>Save note</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { if (confirm("Permanently delete this application?")) start(async () => { await deleteApplicationAction(a.id, jobId); router.refresh(); }); }}>Delete</Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
