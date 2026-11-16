"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TagInput } from "@/components/ui/tag-input";
import { TITLE_RECOMMENDED_MAX, DESCRIPTION_RECOMMENDED_MAX } from "@/lib/seo-rules";

export type SeoFormState = {
  title: string; description: string; keywords: string[]; canonical: string; ogTitle: string; ogDescription: string;
  image: string; noindex: boolean; nofollow: boolean; directives: string;
};

export const emptySeoForm: SeoFormState = { title: "", description: "", keywords: [], canonical: "", ogTitle: "", ogDescription: "", image: "", noindex: false, nofollow: false, directives: "" };

function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return <span className={over ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{value.length}/{max} recommended</span>;
}

/** Shared SEO inputs. Empty fields fall back (route default → global settings); the hints say what the fallback is. */
export function SeoFields({
  value, onChange, idPrefix, showOg = false, showRobots = false, fallbackHint = "Leave blank to use the automatic value.",
}: {
  value: SeoFormState; onChange: (patch: Partial<SeoFormState>) => void; idPrefix: string;
  showOg?: boolean; showRobots?: boolean; fallbackHint?: string;
}) {
  const id = (n: string) => `${idPrefix}-${n}`;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2"><Label htmlFor={id("title")}>SEO title</Label><Counter value={value.title} max={TITLE_RECOMMENDED_MAX} /></div>
        <Input id={id("title")} value={value.title} maxLength={120} onChange={(e) => onChange({ title: e.target.value })} />
        <p className="text-xs text-muted-foreground">{fallbackHint}</p>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2"><Label htmlFor={id("desc")}>Meta description</Label><Counter value={value.description} max={DESCRIPTION_RECOMMENDED_MAX} /></div>
        <Textarea id={id("desc")} rows={3} value={value.description} maxLength={320} onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <TagInput label="Keywords" value={value.keywords} onChange={(keywords) => onChange({ keywords })} />
      <div className="space-y-1.5">
        <Label htmlFor={id("image")}>Social / OG image URL</Label>
        <Input id={id("image")} inputMode="url" placeholder="https://… or /path" value={value.image} onChange={(e) => onChange({ image: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("canonical")}>Canonical URL override</Label>
        <Input id={id("canonical")} inputMode="url" placeholder="Blank = this page's own URL" value={value.canonical} onChange={(e) => onChange({ canonical: e.target.value })} />
        <p className="text-xs text-muted-foreground">A path (/about-us) or a full URL on this site. Other domains are rejected. Pages with a canonical elsewhere are left out of the sitemap.</p>
      </div>
      {showOg && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor={id("ogt")}>OG title (optional)</Label><Input id={id("ogt")} value={value.ogTitle} maxLength={120} onChange={(e) => onChange({ ogTitle: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor={id("ogd")}>OG description (optional)</Label><Input id={id("ogd")} value={value.ogDescription} maxLength={320} onChange={(e) => onChange({ ogDescription: e.target.value })} /></div>
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Search engine visibility</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={!value.noindex} onChange={(e) => onChange({ noindex: !e.target.checked })} /> Index — allow this page in search results</label>
        {showRobots && (
          <>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={!value.nofollow} onChange={(e) => onChange({ nofollow: !e.target.checked })} /> Follow — allow crawlers to follow its links</label>
            <div className="space-y-1.5">
              <Label htmlFor={id("dir")}>Custom robots directives (optional)</Label>
              <Input id={id("dir")} placeholder="e.g. noarchive, max-snippet:160" value={value.directives} onChange={(e) => onChange({ directives: e.target.value })} />
              <p className="text-xs text-muted-foreground">Allowed: noarchive, nosnippet, noimageindex, notranslate, max-snippet:N, max-image-preview:none|standard|large, max-video-preview:N.</p>
            </div>
          </>
        )}
      </fieldset>
    </div>
  );
}

export function SaveMessage({ state }: { state: { ok: boolean; text: string; warnings?: string[] } | null }) {
  if (!state) return null;
  return (
    <div role={state.ok ? "status" : "alert"} className={state.ok ? "text-sm text-success" : "text-sm text-destructive"}>
      {state.text}
      {state.warnings?.map((w) => <p key={w} className="text-xs text-muted-foreground">{w}</p>)}
    </div>
  );
}
