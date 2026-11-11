"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  deleteAttributeAction,
  deleteAttributeGroupAction,
  deleteAttributeOptionAction,
  saveAttributeAction,
  saveAttributeGroupAction,
  saveAttributeOptionAction,
} from "@/server/actions/admin-attribute.actions";

type Type = "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "MULTI_SELECT";
export type AttributeRow = {
  id: string; name: string; slug: string; valueType: Type; unit: string | null; minNumber: number | null; maxNumber: number | null;
  maxLength: number | null; isRequired: boolean; isFilterable: boolean; showOnProduct: boolean; sortOrder: number; isActive: boolean;
  options: { id: string; value: string; label: string }[]; productCount: number;
};
export type GroupRow = { id: string; name: string; sortOrder: number; isActive: boolean; attributes: AttributeRow[] };

const TYPE_LABEL: Record<Type, string> = { TEXT: "Text", NUMBER: "Number / measurement", BOOLEAN: "Yes / No", SELECT: "Choose one", MULTI_SELECT: "Choose several" };
const TYPE_HELP: Record<Type, string> = {
  TEXT: "Free text (e.g. “Care instructions”). Cannot be used as a shop filter.",
  NUMBER: "A measurement with an optional unit and range (e.g. 12 cm). Filterable by range.",
  BOOLEAN: "A simple Yes/No (e.g. “Handmade”). Filterable.",
  SELECT: "The product has exactly one of your options (e.g. Material: Clay). Filterable.",
  MULTI_SELECT: "The product can have several of your options (e.g. Occasion). Filterable.",
};
const CHECK_HELP: Record<"isRequired" | "isFilterable" | "showOnProduct" | "isActive", string> = {
  isRequired: "Admins must fill it in when saving a product that uses it.",
  isFilterable: "Customers can filter the shop by it (not available for Text).",
  showOnProduct: "Appears in the Specifications table on the product page.",
  isActive: "Inactive attributes are hidden from the shop and the product editor.",
};
const cls = "grid gap-1 text-xs font-medium text-muted-foreground";
const selectCls = "h-10 rounded-md border border-input bg-background px-3 text-sm";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ success: boolean; message?: string }>, ok?: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.success) return void toast.error(r.message ?? "Something went wrong.");
      if (ok) toast.success(ok);
      after?.();
      router.refresh();
    });
  return { pending, run };
}

function OptionsEditor({ attribute }: { attribute: AttributeRow }) {
  const { pending, run } = useRun();
  const [label, setLabel] = useState("");
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Options</p>
      <ul className="flex flex-wrap gap-2">
        {attribute.options.map((o) => (
          <li key={o.id} className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-sm">
            {o.label}
            <button type="button" aria-label={`Delete option ${o.label}`} disabled={pending} onClick={() => run(() => deleteAttributeOptionAction(attribute.id, o.id))}>
              <Trash2 className="size-3.5 text-destructive" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New option (e.g. Walnut)" maxLength={80} className="max-w-xs" />
        <Button type="button" size="sm" disabled={pending || !label.trim()} onClick={() => run(() => saveAttributeOptionAction(attribute.id, null, { label }), undefined, () => setLabel(""))}>Add option</Button>
      </div>
    </div>
  );
}

function AttributeForm({ groupId, attribute, onDone }: { groupId: string; attribute: AttributeRow | null; onDone?: () => void }) {
  const { pending, run } = useRun();
  const [f, setF] = useState({
    name: attribute?.name ?? "", valueType: (attribute?.valueType ?? "TEXT") as Type, unit: attribute?.unit ?? "",
    minNumber: attribute?.minNumber?.toString() ?? "", maxNumber: attribute?.maxNumber?.toString() ?? "", maxLength: attribute?.maxLength?.toString() ?? "",
    isRequired: attribute?.isRequired ?? false, isFilterable: attribute?.isFilterable ?? false, showOnProduct: attribute?.showOnProduct ?? true,
    sortOrder: attribute?.sortOrder ?? 0, isActive: attribute?.isActive ?? true,
  });
  const n = (v: string) => (v.trim() === "" ? null : Number(v));
  const save = () =>
    run(
      () => saveAttributeAction(attribute?.id ?? null, {
        groupId, name: f.name, valueType: f.valueType, unit: f.valueType === "NUMBER" ? f.unit || null : null,
        minNumber: f.valueType === "NUMBER" ? n(f.minNumber) : null, maxNumber: f.valueType === "NUMBER" ? n(f.maxNumber) : null,
        maxLength: f.valueType === "TEXT" ? n(f.maxLength) : null, isRequired: f.isRequired,
        isFilterable: f.valueType === "TEXT" ? false : f.isFilterable, showOnProduct: f.showOnProduct, sortOrder: f.sortOrder, isActive: f.isActive,
      }),
      "Saved",
      () => { if (!attribute) setF({ ...f, name: "" }); onDone?.(); },
    );
  const check = (k: "isRequired" | "isFilterable" | "showOnProduct" | "isActive", text: string) => (
    <label className="flex items-center gap-2 text-sm" title={CHECK_HELP[k]}><input type="checkbox" checked={f[k]} disabled={k === "isFilterable" && f.valueType === "TEXT"} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />{text} <span className="text-xs text-muted-foreground">— {CHECK_HELP[k]}</span></label>
  );
  return (
    <div className="grid gap-3 rounded-lg border border-border/70 p-4 sm:grid-cols-3">
      <label className={`${cls} sm:col-span-2`}>Name<Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></label>
      <label className={cls}>Type
        <select className={selectCls} value={f.valueType} onChange={(e) => setF({ ...f, valueType: e.target.value as Type })}>
          {(Object.keys(TYPE_LABEL) as Type[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <span className="font-normal">{TYPE_HELP[f.valueType]}</span>
      </label>
      {f.valueType === "NUMBER" && (<>
        <label className={cls}>Unit (e.g. cm, kg, W)<Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} maxLength={12} /></label>
        <label className={cls}>Minimum<Input type="number" value={f.minNumber} onChange={(e) => setF({ ...f, minNumber: e.target.value })} /></label>
        <label className={cls}>Maximum<Input type="number" value={f.maxNumber} onChange={(e) => setF({ ...f, maxNumber: e.target.value })} /></label>
      </>)}
      {f.valueType === "TEXT" && <label className={cls}>Max length<Input type="number" value={f.maxLength} onChange={(e) => setF({ ...f, maxLength: e.target.value })} /></label>}
      <label className={cls}>Display order<Input type="number" min={0} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Math.max(0, Number(e.target.value) || 0) })} /></label>
      <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-3">
        {check("isRequired", "Required when assigned")}
        {check("isFilterable", "Use as a shop filter")}
        {check("showOnProduct", "Show on product page")}
        {check("isActive", "Active")}
      </div>
      <div className="sm:col-span-3"><Button type="button" size="sm" disabled={pending || !f.name.trim()} onClick={save}>{attribute ? "Save attribute" : "Add attribute"}</Button></div>
    </div>
  );
}

function GroupCard({ group }: { group: GroupRow }) {
  const { pending, run } = useRun();
  const [name, setName] = useState(group.name);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className={`${cls} min-w-56 flex-1`}>Group name<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => saveAttributeGroupAction(group.id, { name, sortOrder: group.sortOrder, isActive: group.isActive }), "Saved")}>Rename</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => saveAttributeGroupAction(group.id, { name: group.name, sortOrder: group.sortOrder, isActive: !group.isActive }))}>{group.isActive ? "Hide group" : "Show group"}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { if (confirm("Delete this group?")) run(() => deleteAttributeGroupAction(group.id)); }}>Delete</Button>
      </div>
      <ul className="space-y-2">
        {group.attributes.length === 0 && <li className="text-sm text-muted-foreground">No attributes in this group yet.</li>}
        {group.attributes.map((a) => (
          <li key={a.id} className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="font-medium">{a.name}</span>{" "}
                <span className="text-muted-foreground">· {TYPE_LABEL[a.valueType]}{a.unit ? ` (${a.unit})` : ""}{a.isRequired ? " · required" : ""}{a.isFilterable ? " · filter" : ""}{!a.isActive ? " · inactive" : ""} · {a.productCount} product(s)</span>
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? "Close" : "Edit"}</Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => { if (confirm(`Delete “${a.name}”${a.productCount ? ` and its values on ${a.productCount} product(s)` : ""}?`)) run(() => deleteAttributeAction(a.id)); }}>Delete</Button>
              </div>
            </div>
            {open === a.id && <AttributeForm groupId={group.id} attribute={a} onDone={() => setOpen(null)} />}
            {(a.valueType === "SELECT" || a.valueType === "MULTI_SELECT") && <OptionsEditor attribute={a} />}
          </li>
        ))}
      </ul>
      <details className="rounded-lg border border-dashed border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Add an attribute to this group</summary>
        <div className="pt-3"><AttributeForm groupId={group.id} attribute={null} /></div>
      </details>
    </section>
  );
}

export function AttributeManager({ groups }: { groups: GroupRow[] }) {
  const { pending, run } = useRun();
  const [name, setName] = useState("");
  return (
    <div className="space-y-6">
      <ol className="list-decimal space-y-1 rounded-lg bg-secondary/60 p-4 pl-8 text-sm">
        <li><strong>Group</strong> — a heading that keeps related attributes together (e.g. “Dimensions”). Groups do not belong to categories.</li>
        <li><strong>Attribute</strong> — one property inside a group (e.g. “Height”, type Number, unit cm). Choose-one/several types also need <strong>options</strong>.</li>
        <li><strong>Assign</strong> — open any product → <em>Attributes</em> card and fill in the values. Only attributes you fill in appear for that product.</li>
      </ol>
      <p className="text-sm text-muted-foreground">
        Attributes describe products (material, voltage, dimensions…). They are separate from categories and never affect stock or price —
        purchasable options like size or colour variants stay on the product&apos;s Variants.
      </p>
      {groups.map((g) => <GroupCard key={g.id} group={g} />)}
      <div className="flex max-w-md items-end gap-2">
        <label className={`${cls} flex-1`}>New attribute group (e.g. “Dimensions”)<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <Button disabled={pending || !name.trim()} onClick={() => run(() => saveAttributeGroupAction(null, { name }), "Group added", () => setName(""))}>Add group</Button>
      </div>
    </div>
  );
}
