"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveProductAttributesAction } from "@/server/actions/admin-attribute.actions";
import { useReportDirty } from "@/features/admin/product-editor-dirty";

export type AttributeDraft = { assigned: string[]; values: Record<string, unknown> };

type Def = {
  id: string; name: string; groupName: string; valueType: "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "MULTI_SELECT";
  unit: string | null; isRequired: boolean; options: { id: string; label: string }[];
};

/**
 * With a productId it saves to that product. Without one (the create flow) it is a draft editor: every change is
 * reported through `onDraftChange` and persisted by the parent right after the product's first save.
 */
export function ProductAttributesCard({
  productId,
  defs,
  current,
  initialDraft,
  onDraftChange,
}: {
  productId: string | null;
  defs: Def[];
  current: Record<string, unknown>;
  initialDraft?: AttributeDraft;
  onDraftChange?: (draft: AttributeDraft) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Record<string, unknown>>(initialDraft?.values ?? current);
  const [assigned, setAssigned] = useState<string[]>(initialDraft?.assigned ?? Object.keys(current));
  // What is stored right now; replaced after every successful save so "dirty" does not depend on a server round-trip.
  const [saved, setSaved] = useState<AttributeDraft>({ assigned: Object.keys(current), values: current });
  const [adding, setAdding] = useState("");
  const set = (id: string, v: unknown) => setValues((p) => ({ ...p, [id]: v }));

  function save() {
    if (!productId) return;
    start(async () => {
      const r = await saveProductAttributesAction(productId, assigned.map((attributeId) => ({ attributeId, value: values[attributeId] ?? "" })));
      if (!r.success) return void toast.error(r.message);
      setSaved({ assigned: [...assigned], values: { ...values } });
      toast.success("Attributes saved");
      router.refresh();
    });
  }

  const available = defs.filter((d) => !assigned.includes(d.id));
  const missingRequired = defs.filter((d) => d.isRequired && !assigned.includes(d.id));
  const norm = (a: string[], v: Record<string, unknown>) => JSON.stringify([[...a].sort(), a.map((id) => [id, v[id] ?? ""]).sort()]);
  const dirty = norm(assigned, values) !== norm(saved.assigned, saved.values);
  useReportDirty("attributes", productId ? dirty || pending : false);
  useEffect(() => {
    if (!productId) onDraftChange?.({ assigned, values });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigned, values, productId]);
  const input = (d: Def) => {
    const v = values[d.id];
    if (d.valueType === "BOOLEAN")
      return <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={v === true ? "true" : v === false ? "false" : ""} onChange={(e) => set(d.id, e.target.value === "" ? "" : e.target.value === "true")}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>;
    if (d.valueType === "SELECT")
      return <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={(v as string) ?? ""} onChange={(e) => set(d.id, e.target.value)}><option value="">—</option>{d.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>;
    if (d.valueType === "MULTI_SELECT") {
      const sel = (v as string[] | undefined) ?? [];
      return <div className="flex flex-wrap gap-3">{d.options.map((o) => <label key={o.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={sel.includes(o.id)} onChange={(e) => set(d.id, e.target.checked ? [...sel, o.id] : sel.filter((x) => x !== o.id))} />{o.label}</label>)}</div>;
    }
    return <Input type={d.valueType === "NUMBER" ? "number" : "text"} step="any" value={(v as string | number | undefined) ?? ""} onChange={(e) => set(d.id, e.target.value)} />;
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Only the attributes you add here apply to this product. They describe the product and power the shop filters; sizes, colours, SKUs, prices and stock belong in <strong>Variants</strong>, not here.</p>
      {missingRequired.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-sm">
          <span>{missingRequired.length} required attribute{missingRequired.length > 1 ? "s are" : " is"} not added yet: {missingRequired.map((d) => d.name).join(", ")}.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setAssigned((a) => [...a, ...missingRequired.map((d) => d.id)])}>Add them</Button>
        </div>
      )}
      {assigned.length === 0 && <p className="text-sm text-muted-foreground">No attributes assigned.</p>}
      {assigned.map((id) => {
        const d = defs.find((x) => x.id === id);
        if (!d) return null;
        return (
          <div key={id} className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
            <label className="grid gap-1 text-sm font-medium">{d.groupName} · {d.name}{d.unit ? ` (${d.unit})` : ""}{d.isRequired ? " *" : ""}{input(d)}</label>
            <button type="button" aria-label={`Remove ${d.name}`} className="mb-2" onClick={() => { setAssigned((a) => a.filter((x) => x !== id)); setValues((p) => { const n = { ...p }; delete n[id]; return n; }); }}><Trash2 className="size-4 text-destructive" /></button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Add attribute" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add an attribute…</option>
          {available.map((d) => <option key={d.id} value={d.id}>{d.groupName} · {d.name}</option>)}
        </select>
        <Button type="button" variant="outline" size="sm" disabled={!adding} onClick={() => { setAssigned((a) => [...a, adding]); setAdding(""); }}>Add</Button>
        {productId ? <Button type="button" size="sm" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save attributes"}</Button> : <span className="text-xs text-muted-foreground">Saved together with the product.</span>}
        {productId && dirty && !pending && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
      </div>
    </div>
  );
}
