"use client";

import { ImageOff } from "lucide-react";
import { DESCRIPTION_MAX, TITLE_MAX, clampText, safeImageUrl, siteOrigin } from "@/lib/seo";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/** Plain-language length guidance (no scores): says what will happen to the text, nothing more. */
export function lengthHint(length: number, kind: "title" | "description", fallbackNote: string): { tone: "muted" | "ok" | "warn"; text: string } {
  if (length === 0) return { tone: "muted", text: fallbackNote };
  if (kind === "title") {
    if (length > TITLE_MAX) return { tone: "warn", text: `Longer than about ${TITLE_MAX} characters, so search results will probably cut it off.` };
    if (length < 25) return { tone: "muted", text: "Quite short. Add what the product is or who it is for, if it fits." };
    return { tone: "ok", text: "Good length for search results." };
  }
  if (length > DESCRIPTION_MAX) return { tone: "warn", text: `Longer than about ${DESCRIPTION_MAX} characters, so search results will probably cut it off.` };
  if (length < 70) return { tone: "muted", text: "Quite short. One or two sentences describing the product work well." };
  return { tone: "ok", text: "Good length for search results." };
}

export function SeoCounter({ value, kind, fallbackNote }: { value: string; kind: "title" | "description"; fallbackNote: string }) {
  const max = kind === "title" ? TITLE_MAX : DESCRIPTION_MAX;
  const hint = lengthHint(value.trim().length, kind, fallbackNote);
  return (
    <p className={cn("text-xs", hint.tone === "warn" ? "text-destructive" : hint.tone === "ok" ? "text-emerald-700" : "text-muted-foreground")}>
      {value.trim().length}/{max} · {hint.text}
    </p>
  );
}

/** What the page will actually use: the admin's text, else the fallback the storefront falls back to. */
export function SeoPreview({
  title,
  fallbackTitle,
  description,
  fallbackDescription,
  path,
  image,
  noindex,
}: {
  title: string;
  fallbackTitle: string;
  description: string;
  fallbackDescription: string;
  path: string;
  image?: string | null;
  noindex?: boolean;
}) {
  const name = siteConfig.name;
  const effectiveTitle = title.trim() || fallbackTitle.trim() || "Untitled";
  const withBrand = effectiveTitle.toLowerCase().includes(name.toLowerCase()) ? effectiveTitle : `${effectiveTitle} | ${name}`;
  const shownDescription = clampText(description.trim() || fallbackDescription, DESCRIPTION_MAX);
  const host = siteOrigin().replace(/^https?:\/\//, "");
  const crumbs = path.split("/").filter(Boolean).join(" › ");
  const img = safeImageUrl(image);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-white p-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">How it can look in search results</p>
        {noindex && <p className="mb-2 text-xs text-destructive">Hidden from search engines: this page will not appear in results.</p>}
        <p className="truncate text-xs text-[#202124]">{host}{crumbs ? ` › ${crumbs}` : ""}</p>
        <p className="mt-0.5 text-lg leading-snug text-[#1a0dab]">{clampText(withBrand, TITLE_MAX)}</p>
        <p className="mt-0.5 text-sm leading-snug text-[#4d5156]">{shownDescription || "No description yet."}</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-white">
        <p className="p-4 pb-2 text-xs font-medium text-muted-foreground">How it can look when shared (Facebook, WhatsApp, X)</p>
        <div className="mx-4 mb-4 overflow-hidden rounded-lg border border-border/70">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element -- admin preview of an arbitrary stored URL
            <img src={img} alt="" className="aspect-[1.91/1] w-full object-cover" />
          ) : (
            <div className="flex aspect-[1.91/1] w-full items-center justify-center gap-2 bg-secondary text-xs text-muted-foreground">
              <ImageOff className="size-4" aria-hidden /> No image: shares will show a plain link
            </div>
          )}
          <div className="space-y-0.5 bg-secondary/40 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{host}</p>
            <p className="line-clamp-2 text-sm font-semibold">{withBrand}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">{shownDescription}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
