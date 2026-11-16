"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/features/admin/rich-text-editor";
import { CmsContent } from "@/components/layout/cms-content";
import { slugFromTitle } from "@/lib/seo-pages";
import { saveStaticPageAction, deleteStaticPageAction } from "@/server/actions/admin-seo.actions";
import { SeoFields, SaveMessage, type SeoFormState } from "./seo-fields";
import { SeoPreview } from "./seo-preview";

export type StaticPageInitial = {
  id?: string; systemKey?: string; slug: string; title: string; content: string; isPublished: boolean; sortOrder: number; showInFooter: boolean; seo: SeoFormState;
};

const PROSE = "space-y-4 text-sm leading-relaxed [&_h2]:mt-6 [&_h2]:font-heading [&_h2]:text-xl [&_h3]:mt-4 [&_h3]:font-heading [&_h3]:text-lg [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:underline";

export function StaticPageForm({ initial, path, origin, siteName }: { initial: StaticPageInitial; path: string; origin: string; siteName: string }) {
  const router = useRouter();
  const system = Boolean(initial.systemKey);
  const [v, setV] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(Boolean(initial.id));
  const [preview, setPreview] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (p: Partial<StaticPageInitial>) => setV((s) => ({ ...s, ...p }));

  function save(publish?: boolean) {
    setMsg(null);
    start(async () => {
      const r = await saveStaticPageAction({
        id: v.id, systemKey: v.systemKey, slug: v.slug, title: v.title, content: v.content, isPublished: publish ?? v.isPublished, sortOrder: v.sortOrder, showInFooter: v.showInFooter,
        seoTitle: v.seo.title, seoDescription: v.seo.description, seoKeywords: v.seo.keywords, canonicalUrl: v.seo.canonical, ogImage: v.seo.image,
        noIndex: v.seo.noindex, noFollow: v.seo.nofollow, robotsDirectives: v.seo.directives,
      });
      if (!r.success) return setMsg({ ok: false, text: r.message });
      if (!v.id && r.id) return router.replace(`/admin/seo/static-pages/${r.id}`);
      if (publish !== undefined) set({ isPublished: publish });
      setMsg({ ok: true, text: publish === true ? "Published." : publish === false ? "Unpublished." : "Saved." });
      router.refresh();
    });
  }

  function remove() {
    if (!v.id || !window.confirm(system ? "Remove this replacement? The built-in page content will show again." : "Delete this page permanently?")) return;
    start(async () => {
      const r = await deleteStaticPageAction(v.id!);
      if (r.success) router.replace("/admin/seo/static-pages"); else setMsg({ ok: false, text: r.message });
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-6">
        <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
          <div className="space-y-1.5"><Label htmlFor="sp-title">Page title</Label>
            <Input id="sp-title" maxLength={160} value={v.title} onChange={(e) => { set({ title: e.target.value, ...(slugTouched || system ? {} : { slug: slugFromTitle(e.target.value) }) }); }} /></div>
          <div className="space-y-1.5"><Label htmlFor="sp-slug">URL slug</Label>
            {system ? <p className="text-sm text-muted-foreground">This replaces the built-in page at <code>{path}</code>. Its URL does not change.</p> : (
              <>
                <div className="flex items-center gap-1 text-sm"><span className="text-muted-foreground">/pages/</span>
                  <Input id="sp-slug" className="max-w-xs" value={v.slug} onChange={(e) => { setSlugTouched(true); set({ slug: e.target.value.toLowerCase() }); }} /></div>
                <p className="text-xs text-muted-foreground">Lowercase letters, numbers and hyphens. Reserved names (admin, shop, cart, …) are refused. Changing the slug of a published page changes its URL — add a redirect from the old one.</p>
              </>
            )}</div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between"><Label>Content</Label>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</Button></div>
            {preview
              ? <div className="min-h-40 rounded-lg border border-border/70 bg-background p-4"><h1 className="mb-4 font-heading text-2xl">{v.title}</h1><CmsContent html={v.content} className={PROSE} /></div>
              : <RichTextEditor value={v.content} onChange={(content) => set({ content })} placeholder="Write the page content…" />}
            <p className="text-xs text-muted-foreground">Headings, lists, bold/italic and links only. Scripts, styles, embeds, images and inline attributes are stripped when saved and again when shown.</p>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="font-heading text-lg">Publishing</h2>
          <p className="text-sm">Status: <strong>{v.isPublished ? "Published" : "Draft (not visible)"}</strong></p>
          {!system && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="sp-order">Order</Label><Input id="sp-order" type="number" value={v.sortOrder} onChange={(e) => set({ sortOrder: Number(e.target.value) })} /></div>
              <label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" className="size-4" checked={v.showInFooter} onChange={(e) => set({ showInFooter: e.target.checked })} /> Link from the footer</label>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
          <h2 className="font-heading text-lg">SEO</h2>
          {system && (
            <p className="text-sm text-muted-foreground">While this replacement is published, fields you fill in here take priority over <Link className="underline" href="/admin/seo/pages">Page SEO</Link> for this page; blank fields fall back to Page SEO, then the global defaults. Unpublish or remove the replacement and Page SEO applies on its own again.</p>
          )}
          <SeoFields idPrefix="sp" value={v.seo} showRobots onChange={(p) => set({ seo: { ...v.seo, ...p } })} fallbackHint={system ? "Blank = Page SEO, then the built-in title." : "Blank = the page title."} />
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => save()} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          {v.isPublished
            ? <Button variant="outline" onClick={() => save(false)} disabled={pending || !v.id}>Unpublish</Button>
            : <Button variant="outline" onClick={() => save(true)} disabled={pending}>Save & publish</Button>}
          {v.id && <Button variant="ghost" className="text-destructive" onClick={remove} disabled={pending}>{system ? "Remove replacement" : "Delete"}</Button>}
          <SaveMessage state={msg} />
        </div>
      </div>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <SeoPreview title={v.seo.title || v.title} description={v.seo.description || v.content.replace(/<[^>]*>/g, " ")} url={system ? `${origin}${path === "/" ? "" : path}` : `${origin}/pages/${v.slug || "…"}`} image={v.seo.image || null} siteName={siteName} />
      </aside>
    </div>
  );
}
