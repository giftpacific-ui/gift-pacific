"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { saveEntitySeoAction } from "@/server/actions/admin-seo.actions";
import type { EntityKind } from "@/server/services/admin-seo.service";
import { SeoFields, SaveMessage, type SeoFormState } from "./seo-fields";
import { SeoPreview } from "./seo-preview";

export function EntitySeoDialog({
  kind, id, name, path, origin, siteName, initial, fallbackTitle,
}: { kind: EntityKind; id: string; name: string; path: string; origin: string; siteName: string; initial: SeoFormState; fallbackTitle: string }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveEntitySeoAction(kind, id, { title: form.title, description: form.description, keywords: form.keywords, image: form.image, canonical: form.canonical, noindex: form.noindex });
      if (r.success) { setOpen(false); router.refresh(); } else setMsg({ ok: false, text: r.message });
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setForm(initial); setMsg(null); } }}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Edit SEO</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>SEO — {name}</DialogTitle><DialogDescription>{path}</DialogDescription></DialogHeader>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
          <SeoFields idPrefix={`e-${id}`} value={form} onChange={(p) => setForm((s) => ({ ...s, ...p }))} fallbackHint={`Blank = "${fallbackTitle}" (from the ${kind}'s own data).`} />
          <SeoPreview title={form.title || fallbackTitle} description={form.description} url={`${origin}${path}`} image={form.image || null} siteName={siteName} />
        </div>
        <div className="flex items-center gap-4"><Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button><SaveMessage state={msg} /></div>
      </DialogContent>
    </Dialog>
  );
}
