"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { importEmailContactsCsvAction, previewEmailContactsCsvAction } from "@/server/actions/admin-email-contact.actions";
import { CSV_COLUMNS, CSV_TEMPLATE, MAX_CSV_BYTES, MAX_CSV_ROWS, csvSafe, type CsvImportSummary, type CsvPreview } from "@/lib/email-contacts";

type Stage = "choose" | "preview" | "done";

function Count({ label, value, tone }: { label: string; value: number; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold ${tone === "bad" && value > 0 ? "text-destructive" : tone === "good" && value > 0 ? "text-success" : ""}`}>{value.toLocaleString("en-US")}</p>
    </div>
  );
}

function Issues({ issues, truncated }: { issues: { row: number; message: string }[]; truncated: boolean }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">Rows needing attention</p>
      <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border/70 p-3 text-sm">
        {issues.map((i, n) => <li key={`${i.row}-${n}`}><span className="font-medium">Row {i.row}:</span> {i.message}</li>)}
      </ul>
      {truncated && <p className="text-xs text-muted-foreground">Only the first {issues.length} are shown.</p>}
    </div>
  );
}

export function ImportCsvDialog() {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("choose");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [summary, setSummary] = useState<CsvImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attest, setAttest] = useState(false);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function reset() { setStage("choose"); setFileName(""); setCsv(""); setPreview(null); setSummary(null); setError(null); setAttest(false); if (input.current) input.current.value = ""; }

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) { setError(`The file is too large (limit ${Math.floor(MAX_CSV_BYTES / 1000)} KB, ${MAX_CSV_ROWS.toLocaleString("en-US")} rows). Split it into smaller files.`); return; }
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    start(async () => {
      const res = await previewEmailContactsCsvAction(text);
      if (res.success) { setPreview(res.preview); setAttest(false); setStage("preview"); }
      else { setError(res.message); setPreview(null); }
    });
  }

  function runImport() {
    setError(null);
    start(async () => {
      const res = await importEmailContactsCsvAction(csv, attest);
      if (res.success) { setSummary(res.summary); setStage("done"); toast.success("Import finished."); router.refresh(); }
      else setError(res.message);
    });
  }

  const needsAttest = (preview?.consentRequested ?? 0) > 0;
  const canImport = !!preview && preview.validRows > 0 && (!needsAttest || attest) && !pending;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild><Button type="button" variant="outline"><Upload /> Import CSV</Button></DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import contacts from CSV</DialogTitle>
          <DialogDescription>Importing an address never grants marketing consent. Consent is recorded only for rows with marketing_consent set to true and written evidence.</DialogDescription>
        </DialogHeader>

        {stage === "choose" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ec-csv">CSV file</Label>
              <Input id="ec-csv" ref={input} type="file" accept=".csv,text/csv" disabled={pending} onChange={(e) => void onFile(e.target.files?.[0])} />
              <p className="text-xs text-muted-foreground">Columns: {CSV_COLUMNS.join(", ")} (email is required). Comma separated, up to {MAX_CSV_ROWS.toLocaleString("en-US")} rows and {Math.floor(MAX_CSV_BYTES / 1000)} KB.</p>
            </div>
            <a className="inline-flex items-center gap-1.5 text-sm underline" download="contacts-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`}><Download className="size-4" /> Download a template</a>
            {pending && <p className="text-sm text-muted-foreground" role="status">Checking the file…</p>}
          </div>
        )}

        {stage === "preview" && preview && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Preview of <span className="font-medium text-foreground">{csvSafe(fileName)}</span>. Nothing has been imported yet.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Count label="Total rows" value={preview.totalRows} />
              <Count label="Valid rows" value={preview.validRows} tone="good" />
              <Count label="Invalid rows" value={preview.invalidRows} tone="bad" />
              <Count label="Duplicate rows" value={preview.duplicateRows} tone="bad" />
              <Count label="New contacts" value={preview.newContacts} />
              <Count label="Existing contacts" value={preview.existingContacts} />
              <Count label="Rows recording consent" value={preview.consentRequested} />
              <Count label="Consent will be refused" value={preview.consentBlocked} tone="bad" />
            </div>
            <Issues issues={preview.issues} truncated={preview.issuesTruncated} />
            <div className="overflow-x-auto rounded-lg border border-border/70">
              <table className="w-full min-w-150 text-sm">
                <thead className="border-b border-border/70 text-left text-muted-foreground"><tr><th className="p-2">Row</th><th className="p-2">Email</th><th className="p-2">Name</th><th className="p-2">Result</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} className="border-b border-border/50 last:border-0">
                      <td className="p-2">{r.row}</td>
                      <td className="max-w-56 break-all p-2">{csvSafe(r.email)}</td>
                      <td className="p-2">{csvSafe(r.name) || "—"}</td>
                      <td className="p-2"><Badge variant={r.status === "valid" ? "success" : "destructive"}>{r.status}</Badge> <span className="text-muted-foreground">{r.outcome}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.totalRows > preview.rows.length && <p className="text-xs text-muted-foreground">Showing the first {preview.rows.length} of {preview.totalRows} rows.</p>}
            {needsAttest && (
              <div className="flex items-start gap-2 rounded-lg border border-border/70 p-3">
                <Checkbox id="ec-attest" checked={attest} onCheckedChange={(v) => setAttest(v === true)} className="mt-0.5" />
                <Label htmlFor="ec-attest" className="font-normal leading-snug">I confirm I hold the consent described in the evidence column for the {preview.consentRequested} row(s) that record consent.</Label>
              </div>
            )}
            {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={pending} onClick={reset}>Choose another file</Button>
              <Button type="button" disabled={!canImport} onClick={runImport}>{pending ? "Importing…" : `Import ${preview.validRows} contact(s)`}</Button>
            </div>
          </div>
        )}

        {stage === "done" && summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Count label="Total rows" value={summary.totalRows} />
              <Count label="Valid rows" value={summary.validRows} tone="good" />
              <Count label="Invalid rows" value={summary.invalidRows} tone="bad" />
              <Count label="Duplicate rows" value={summary.duplicateRows} tone="bad" />
              <Count label="New contacts" value={summary.newContacts} tone="good" />
              <Count label="Existing contacts updated" value={summary.existingUpdated} />
              <Count label="Consent recorded" value={summary.consentRecorded} tone="good" />
              <Count label="Skipped or blocked" value={summary.skippedOrBlocked} tone="bad" />
            </div>
            <p className="text-sm text-muted-foreground">{summary.existingContacts} row(s) matched existing contacts{summary.consentAlreadyOnFile ? `; ${summary.consentAlreadyOnFile} already had consent on file` : ""}. Suppressions and consent history were not changed.</p>
            {summary.notProcessed > 0 && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{summary.notProcessed} row(s) were not reached before the time limit. Import the same file again to finish; rows already imported are not duplicated.</p>}
            <Issues issues={summary.issues} truncated={summary.issuesTruncated} />
            <div className="flex justify-end"><Button type="button" onClick={() => setOpen(false)}>Done</Button></div>
          </div>
        )}
        {stage === "choose" && error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
