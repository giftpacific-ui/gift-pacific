"use client";

import { useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shows the REAL generated e-mail (HTML built on the server by the same renderer that produces the stored template, filled with sample customer data)
 * inside a sandboxed iframe: no scripts, no forms, no navigation, so even hostile HTML could not run. Desktop = 640px wide, mobile = 375px wide, which
 * is where the e-mail's own small-screen CSS applies.
 */
export function EmailPreview({ html, subject, error, loading }: { html: string | null; subject?: string | null; error?: string | null; loading?: boolean }) {
  const [mode, setMode] = useState<"desktop" | "mobile">("desktop");
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm"><span className="text-muted-foreground">Subject: </span><span className="truncate font-medium">{subject ?? "—"}</span></div>
        <div className="flex gap-1" role="group" aria-label="Preview size">
          <Button type="button" size="sm" variant={mode === "desktop" ? "default" : "outline"} aria-pressed={mode === "desktop"} onClick={() => setMode("desktop")}><Monitor /> Desktop</Button>
          <Button type="button" size="sm" variant={mode === "mobile" ? "default" : "outline"} aria-pressed={mode === "mobile"} onClick={() => setMode("mobile")}><Smartphone /> Mobile</Button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div className="overflow-auto rounded-md border bg-muted/40 p-3" aria-busy={loading}>
        {html ? (
          <iframe title={`${mode} preview`} sandbox="" srcDoc={html} className="mx-auto block h-[720px] max-w-full rounded bg-white shadow-sm"
            style={{ width: mode === "mobile" ? 375 : 640, opacity: loading ? 0.6 : 1 }} />
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">{loading ? "Building preview…" : "The preview appears here once the design is valid."}</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Sample customer data is used. Links in the preview do not work and the unsubscribe link is a sample.</p>
    </div>
  );
}
