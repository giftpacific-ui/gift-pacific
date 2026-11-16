"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TagInput } from "@/components/ui/tag-input";
import { saveGlobalSeoAction } from "@/server/actions/admin-seo.actions";
import { SaveMessage } from "./seo-fields";
import { SeoPreview } from "./seo-preview";

export type GlobalSeoInitial = {
  seoDefaultTitle: string; seoTitleTemplate: string; seoDescription: string; seoKeywords: string[]; seoOgTitle: string; seoOgDescription: string;
  ogImageUrl: string; seoTwitterCard: "summary" | "summary_large_image"; seoCanonicalBaseUrl: string; seoDefaultNoIndex: boolean; seoDefaultNoFollow: boolean;
  seoRobotsExtra: string; seoOrgSchemaEnabled: boolean; seoWebsiteSchemaEnabled: boolean;
};

export function GlobalSeoForm({ initial, siteName, effectiveOrigin }: { initial: GlobalSeoInitial; siteName: string; effectiveOrigin: string }) {
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; warnings?: string[] } | null>(null);
  const [pending, start] = useTransition();
  const set = (p: Partial<GlobalSeoInitial>) => setV((s) => ({ ...s, ...p }));
  const check = (key: keyof GlobalSeoInitial, label: string) => (
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={Boolean(v[key])} onChange={(e) => set({ [key]: e.target.checked } as Partial<GlobalSeoInitial>)} /> {label}</label>
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const r = await saveGlobalSeoAction({ ...v });
      setMsg(r.success ? { ok: true, text: "SEO settings saved.", warnings: r.warnings } : { ok: false, text: r.message });
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={submit} className="space-y-8">
        <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="font-heading text-lg">Defaults for every page</h2>
          <div className="space-y-1.5"><Label htmlFor="g-title">Default SEO title</Label><Input id="g-title" maxLength={120} value={v.seoDefaultTitle} onChange={(e) => set({ seoDefaultTitle: e.target.value })} />
            <p className="text-xs text-muted-foreground">Used for the homepage and any page with no title of its own. Blank = the store name.</p></div>
          <div className="space-y-1.5"><Label htmlFor="g-tpl">Title template</Label><Input id="g-tpl" maxLength={120} placeholder={`%s | ${siteName}`} value={v.seoTitleTemplate} onChange={(e) => set({ seoTitleTemplate: e.target.value })} />
            <p className="text-xs text-muted-foreground">Must contain %s (the page title). A title that already contains the store name is not suffixed twice.</p></div>
          <div className="space-y-1.5"><Label htmlFor="g-desc">Default meta description</Label><Textarea id="g-desc" rows={3} maxLength={320} value={v.seoDescription} onChange={(e) => set({ seoDescription: e.target.value })} /></div>
          <TagInput label="Default keywords" value={v.seoKeywords} onChange={(seoKeywords) => set({ seoKeywords })} />
        </section>

        <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="font-heading text-lg">Social sharing defaults</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="g-ogt">Default OG title</Label><Input id="g-ogt" maxLength={120} value={v.seoOgTitle} onChange={(e) => set({ seoOgTitle: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor="g-ogd">Default OG description</Label><Input id="g-ogd" maxLength={320} value={v.seoOgDescription} onChange={(e) => set({ seoOgDescription: e.target.value })} /></div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="g-img">Default OG image URL</Label><Input id="g-img" inputMode="url" value={v.ogImageUrl} onChange={(e) => set({ ogImageUrl: e.target.value })} />
            <p className="text-xs text-muted-foreground">Used when a page has no image. Blank = the store logo, if any.</p></div>
          <div className="space-y-1.5"><Label htmlFor="g-card">Twitter / X card type</Label>
            <select id="g-card" className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm" value={v.seoTwitterCard} onChange={(e) => set({ seoTwitterCard: e.target.value as "summary" | "summary_large_image" })}>
              <option value="summary_large_image">Summary with large image</option><option value="summary">Summary</option>
            </select>
            <p className="text-xs text-muted-foreground">A page without an image always uses the plain summary card.</p></div>
        </section>

        <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="font-heading text-lg">Canonical URL & robots</h2>
          <div className="space-y-1.5"><Label htmlFor="g-base">Website canonical base URL</Label><Input id="g-base" inputMode="url" placeholder="https://www.example.com" value={v.seoCanonicalBaseUrl} onChange={(e) => set({ seoCanonicalBaseUrl: e.target.value })} />
            <p className="text-xs text-muted-foreground">Origin only. Used for canonical links, Open Graph URLs, sitemap, robots.txt and homepage structured data. Currently in effect: <code>{effectiveOrigin}</code>. Blank = the NEXT_PUBLIC_SITE_URL environment value.</p></div>
          <fieldset className="space-y-2"><legend className="text-sm font-medium">Default robots directive</legend>
            {check("seoDefaultNoIndex", "Ask search engines NOT to index the site (noindex on every page) — use only for staging or a hidden site")}
            {check("seoDefaultNoFollow", "Ask crawlers not to follow links (nofollow on every page)")}
            <p className="text-xs text-muted-foreground">A page-level setting can make a page noindex but cannot override a global noindex.</p></fieldset>
          <div className="space-y-1.5"><Label htmlFor="g-extra">Extra robots.txt rules</Label><Textarea id="g-extra" rows={4} className="font-mono text-xs" placeholder={"Disallow: /private-offers"} value={v.seoRobotsExtra} onChange={(e) => set({ seoRobotsExtra: e.target.value })} />
            <p className="text-xs text-muted-foreground">One <code>Disallow: /path</code> per line. Admin, account, cart, checkout, login, search and API paths are always blocked. Rules that would block shop, product, box, campaign or other public pages are ignored and reported on save.</p></div>
        </section>

        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="font-heading text-lg">Structured data (JSON-LD)</h2>
          {check("seoOrgSchemaEnabled", "Organization — name, logo, contact and social links from Store settings")}
          {check("seoWebsiteSchemaEnabled", "WebSite — with the storefront search action")}
          <p className="text-xs text-muted-foreground">Product, breadcrumb and page markup is generated automatically from real catalog data on those pages. No ratings, reviews or availability are invented.</p>
        </section>

        <div className="flex items-center gap-4">
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save SEO settings"}</Button>
          <SaveMessage state={msg} />
        </div>
      </form>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <SeoPreview title={v.seoDefaultTitle || siteName} description={v.seoDescription} url={effectiveOrigin} image={v.ogImageUrl || null} siteName={siteName} ogTitle={v.seoOgTitle} ogDescription={v.seoOgDescription} twitterCard={v.seoTwitterCard} />
      </aside>
    </div>
  );
}
