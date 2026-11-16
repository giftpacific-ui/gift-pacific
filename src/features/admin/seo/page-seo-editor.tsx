"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { savePageSeoAction } from "@/server/actions/admin-seo.actions";
import { SeoFields, SaveMessage, emptySeoForm, type SeoFormState } from "./seo-fields";
import { SeoPreview } from "./seo-preview";

export type PageSeoItem = { key: string; label: string; path: string; form: SeoFormState };

export function PageSeoEditor({ items, siteName, origin }: { items: PageSeoItem[]; siteName: string; origin: string }) {
  const [activeKey, setActiveKey] = useState(items[0]?.key ?? "");
  const [forms, setForms] = useState<Record<string, SeoFormState>>(() => Object.fromEntries(items.map((i) => [i.key, i.form])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const item = items.find((i) => i.key === activeKey) ?? items[0];
  if (!item) return null;
  const form = forms[item.key] ?? emptySeoForm;

  function save() {
    setMsg(null);
    start(async () => {
      const r = await savePageSeoAction(item.key, {
        title: form.title, description: form.description, keywords: form.keywords, canonicalUrl: form.canonical, ogTitle: form.ogTitle,
        ogDescription: form.ogDescription, ogImage: form.image, noIndex: form.noindex, noFollow: form.nofollow, robotsDirectives: form.directives,
      });
      setMsg(r.success ? { ok: true, text: `${item.label} saved.` } : { ok: false, text: r.message });
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)_22rem]">
      <nav aria-label="Pages" className="overflow-x-auto lg:overflow-visible">
        <ul className="flex gap-1 lg:flex-col">
          {items.map((i) => {
            const f = forms[i.key];
            const custom = f && (f.title || f.description || f.image || f.canonical || f.noindex);
            return (
              <li key={i.key}>
                <button type="button" onClick={() => { setActiveKey(i.key); setMsg(null); }} aria-current={i.key === item.key ? "true" : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap ${i.key === item.key ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                  <span>{i.label}</span>
                  {f?.noindex ? <Badge variant="destructive">noindex</Badge> : custom ? <Badge variant="secondary">custom</Badge> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
        <div><h2 className="font-heading text-lg">{item.label}</h2><p className="text-xs text-muted-foreground">{item.path}</p></div>
        <SeoFields idPrefix={`pg-${item.key}`} value={form} showOg showRobots fallbackHint="Blank = the page's built-in title, then the global default."
          onChange={(p) => setForms((s) => ({ ...s, [item.key]: { ...(s[item.key] ?? emptySeoForm), ...p } }))} />
        <div className="flex items-center gap-4"><Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save page SEO"}</Button><SaveMessage state={msg} /></div>
      </section>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <SeoPreview title={form.title || item.label} description={form.description} url={form.canonical ? (form.canonical.startsWith("/") ? `${origin}${form.canonical}` : form.canonical) : `${origin}${item.path === "/" ? "" : item.path}`}
          image={form.image || null} siteName={siteName} ogTitle={form.ogTitle} ogDescription={form.ogDescription} />
      </aside>
    </div>
  );
}
