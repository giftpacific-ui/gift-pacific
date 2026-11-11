"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TagInput } from "@/components/ui/tag-input";
import { SingleImageUploader, type ImageValue } from "@/features/admin/single-image-uploader";
import { deleteBoxAction, moveBoxAction, saveBoxAction, toggleBoxAction } from "@/server/actions/admin-box.actions";
import { formatPrice } from "@/lib/utils";

export type BoxRow = {
  id: string; name: string; slug: string; description: string | null; imageUrl: string | null; imagePublicId: string | null;
  price: number; sortOrder: number; isActive: boolean; managed: boolean; legacyLinked: boolean; stock: number; allowBackorder: boolean;
  seoTitle: string | null; seoDescription: string | null; seoKeywords: string[];
};

function BoxForm({ box, onDone }: { box: BoxRow | null; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({
    name: box?.name ?? "", slug: box?.slug ?? "", description: box?.description ?? "", price: String(box?.price ?? 0),
    sortOrder: box?.sortOrder ?? 0, isActive: box?.isActive ?? true, stock: String(box?.stock ?? 0), allowBackorder: box?.allowBackorder ?? false,
    seoTitle: box?.seoTitle ?? "", seoDescription: box?.seoDescription ?? "",
  });
  const [keywords, setKeywords] = useState<string[]>(box?.seoKeywords ?? []);
  const [image, setImage] = useState<ImageValue | null>(box?.imageUrl ? { url: box.imageUrl, publicId: box.imagePublicId } : null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    const price = Number(f.price);
    if (f.price.trim() === "" || !Number.isFinite(price)) return setError("Enter the box price.");
    const stock = Number(f.stock);
    if (!Number.isInteger(stock) || stock < 0) return setError("Stock must be a whole number, 0 or more.");
    start(async () => {
      const r = await saveBoxAction(box?.id ?? null, {
        name: f.name, slug: f.slug, description: f.description, price, sortOrder: f.sortOrder, isActive: f.isActive,
        stock, allowBackorder: f.allowBackorder, seoTitle: f.seoTitle, seoDescription: f.seoDescription, seoKeywords: keywords,
        imageUrl: image?.url ?? "", imagePublicId: image?.publicId ?? "",
      });
      // On failure keep everything the admin typed; only a success closes/resets the form.
      if (!r.success) { setError(r.message); toast.error(r.message); return; }
      toast.success("Box saved");
      onDone();
      router.refresh();
    });
  }
  const label = "grid gap-1.5 text-sm font-medium";
  return (
    <div className="grid gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-2">
      <label className={label}>Name<Input value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className={label}>URL slug <span className="font-normal text-muted-foreground">(blank = from name)</span><Input value={f.slug} maxLength={80} onChange={(e) => setF({ ...f, slug: e.target.value })} /></label>
      <label className={label}>Box price (BDT)<Input type="number" min={0} step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
      <label className={label}>Display order (lowest first)<Input type="number" min={0} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Math.max(0, Number(e.target.value) || 0) })} /></label>
      <label className={`${label} sm:col-span-2`}>Description<Textarea rows={3} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      {box?.legacyLinked ? (
        <p className="rounded-lg bg-secondary/60 px-3 py-2 text-sm sm:col-span-2">This box is linked to an ordinary product created before boxes had their own stock. Its price and stock are managed on that product&apos;s page.</p>
      ) : (
        <>
          <label className={label}>Stock (units available)<Input type="number" min={0} step={1} value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} /></label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.allowBackorder} onChange={(e) => setF({ ...f, allowBackorder: e.target.checked })} /> Allow orders when out of stock</label>
        </>
      )}
      <div className="sm:col-span-2"><SingleImageUploader value={image} onChange={setImage} folder="boxes" deferDelete label="Box image (JPEG/PNG/WebP, drag & drop supported)" aspectClassName="aspect-[4/3] max-w-64" /></div>
      <label className={`${label} sm:col-span-2`}>SEO title<Input value={f.seoTitle} maxLength={120} onChange={(e) => setF({ ...f, seoTitle: e.target.value })} /></label>
      <label className={`${label} sm:col-span-2`}>SEO description<Textarea rows={2} maxLength={300} value={f.seoDescription} onChange={(e) => setF({ ...f, seoDescription: e.target.value })} /></label>
      <div className="sm:col-span-2"><p className="mb-1.5 text-sm font-medium">SEO keywords</p><TagInput label="SEO keywords" value={keywords} onChange={setKeywords} /></div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active (visible on the public site)
      </label>
      {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button onClick={save} disabled={pending || !f.name.trim()}>{pending ? "Saving…" : "Save box"}</Button>
        <Button variant="outline" onClick={onDone} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

export function BoxManager({ boxes }: { boxes: BoxRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ success: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.success) toast.error(r.message ?? "Something went wrong.");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {editing === "new" ? <BoxForm key="new" box={null} onDone={() => setEditing(null)} /> : <Button onClick={() => setEditing("new")}>Add box</Button>}
      {boxes.length === 0 && <p className="text-sm text-muted-foreground">No boxes yet. Add one to show it on the Our Boxes page.</p>}
      <ul className="space-y-3">
        {boxes.map((b, i) => (
          <li key={b.id} className="space-y-3">
            {editing === b.id ? (
              <BoxForm key={b.id} box={b} onDone={() => setEditing(null)} />
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card p-3">
                <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-secondary">{b.imageUrl && <Image src={b.imageUrl} alt="" fill sizes="64px" className="object-cover" />}</div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{b.name} <Badge variant={b.isActive ? "default" : "secondary"}>{b.isActive ? "Active" : "Inactive"}</Badge></p>
                  <p className="text-xs text-muted-foreground">/boxes/{b.slug} · {formatPrice(b.price)}{b.legacyLinked ? "" : ` · ${b.stock} in stock`}</p>
                </div>
                <Button size="icon" variant="outline" aria-label="Move up" disabled={pending || i === 0} onClick={() => act(() => moveBoxAction(b.id, "up"))}><ArrowUp className="size-4" /></Button>
                <Button size="icon" variant="outline" aria-label="Move down" disabled={pending || i === boxes.length - 1} onClick={() => act(() => moveBoxAction(b.id, "down"))}><ArrowDown className="size-4" /></Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => toggleBoxAction(b.id, !b.isActive))}>{b.isActive ? "Deactivate" : "Activate"}</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(b.id)}>Edit</Button>
                <Button size="icon" variant="ghost" aria-label={`Delete ${b.name}`} disabled={pending} onClick={() => { if (confirm(`Delete "${b.name}"?`)) act(() => deleteBoxAction(b.id)); }}><Trash2 className="size-4 text-destructive" /></Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
