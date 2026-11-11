"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveCustomizationFieldAction,
  deleteCustomizationFieldAction,
} from "@/server/actions/admin-product.actions";
import { useReportDirty } from "@/features/admin/product-editor-dirty";
import type { ProductCustomizationField, CustomizationFieldType } from "@prisma/client";

const emptyForm = {
  label: "",
  fieldKey: "",
  type: "TEXT" as CustomizationFieldType,
  isRequired: true,
  optionsCsv: "",
  maxLength: "",
  sortOrder: "0",
};

export type CustomizationDraft = typeof emptyForm & { key: string };

/** Payload shape shared by "add now" (edit) and "add after the product exists" (create drafts). */
export function customizationPayload(f: typeof emptyForm) {
  return { ...f, maxLength: f.maxLength ? Number(f.maxLength) : ("" as const), sortOrder: Number(f.sortOrder) };
}

/**
 * With a productId, fields are saved immediately. Without one (create flow) they are drafts owned by the parent
 * (`drafts` / `onDraftsChange`) and written right after the product's first save.
 */
export function ProductCustomizationManager({
  productId,
  fields,
  drafts = [],
  onDraftsChange,
}: {
  productId: string | null;
  fields: ProductCustomizationField[];
  drafts?: CustomizationDraft[];
  onDraftsChange?: (drafts: CustomizationDraft[]) => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  useReportDirty(productId ? "customization" : "create-customization-form", JSON.stringify(form) !== JSON.stringify(emptyForm) || isPending);

  function handleAdd() {
    if (!productId) {
      if (!form.label.trim() || !form.fieldKey.trim()) {
        toast.error("Enter a label and a field key.");
        return;
      }
      if (drafts.some((d) => d.fieldKey === form.fieldKey.trim())) {
        toast.error("That field key is already in the list.");
        return;
      }
      onDraftsChange?.([...drafts, { ...form, fieldKey: form.fieldKey.trim(), key: crypto.randomUUID() }]);
      setForm(emptyForm);
      return;
    }
    startTransition(async () => {
      const result = await saveCustomizationFieldAction(productId, null, customizationPayload(form));
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      setForm(emptyForm);
      toast.success("Field added");
      router.refresh();
    });
  }

  function handleDelete(fieldId: string) {
    if (!productId) return;
    startTransition(async () => {
      const result = await deleteCustomizationFieldAction(fieldId, productId);
      if (!result.success) toast.error(result.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {!productId && drafts.length > 0 && (
        <div className="space-y-2">
          {drafts.map((d) => (
            <div key={d.key} className="flex items-center justify-between rounded-lg border border-dashed border-border p-3 text-sm">
              <div>
                <p className="font-medium">{d.label} <span className="text-muted-foreground">({d.fieldKey})</span></p>
                <p className="text-xs text-muted-foreground">{d.type} · {d.isRequired ? "Required" : "Optional"} · saved with the product</p>
              </div>
              <button type="button" onClick={() => onDraftsChange?.(drafts.filter((x) => x.key !== d.key))} aria-label="Remove field">
                <Trash2 className="size-4 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      )}
      {fields.length > 0 && (
        <div className="space-y-2">
          {fields.map((field) => (
            <div key={field.id} className="flex items-center justify-between rounded-lg border border-border/70 p-3 text-sm">
              <div>
                <p className="font-medium">{field.label} <span className="text-muted-foreground">({field.fieldKey})</span></p>
                <p className="text-xs text-muted-foreground">
                  {field.type} · {field.isRequired ? "Required" : "Optional"}
                </p>
              </div>
              <button type="button" onClick={() => handleDelete(field.id)} aria-label="Delete field">
                <Trash2 className="size-4 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-3 rounded-lg border border-dashed border-border p-4 sm:grid-cols-3">
        <Input placeholder="Label (e.g. Customer Name)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <Input placeholder="Field key (e.g. customerName)" value={form.fieldKey} onChange={(e) => setForm({ ...form, fieldKey: e.target.value })} />
        <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as CustomizationFieldType })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="TEXT">Text</SelectItem>
            <SelectItem value="TEXTAREA">Text area</SelectItem>
            <SelectItem value="DATE">Date</SelectItem>
            <SelectItem value="COLOR">Color choice</SelectItem>
            <SelectItem value="SELECT">Dropdown</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Options (comma separated, for dropdown/color)"
          value={form.optionsCsv}
          onChange={(e) => setForm({ ...form, optionsCsv: e.target.value })}
          className="sm:col-span-2"
        />
        <Input placeholder="Max length" type="number" value={form.maxLength} onChange={(e) => setForm({ ...form, maxLength: e.target.value })} />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={form.isRequired} onCheckedChange={(c) => setForm({ ...form, isRequired: !!c })} />
          Required
        </label>
        <Button type="button" onClick={handleAdd} disabled={isPending}>Add field</Button>
      </div>
    </div>
  );
}
