"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Pencil, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { saveVariantAction, deleteVariantAction } from "@/server/actions/admin-product.actions";
import type { ProductVariant } from "@prisma/client";
import { formatPrice } from "@/lib/utils";
import { useReportDirty } from "@/features/admin/product-editor-dirty";

type VariantFormState = {
  name: string;
  sku: string;
  price: string;
  optionsJson: string;
  stock: string;
  /** Stock when the form was opened; lets the server apply only the admin's own change. */
  loadedStock?: string;
  image: string;
  allowBackorder: boolean;
  isDefault: boolean;
};

function variantToForm(variant: ProductVariant): VariantFormState {
  return {
    name: variant.name,
    sku: variant.sku,
    price: String(Number(variant.price)),
    optionsJson: JSON.stringify(variant.options ?? {}),
    stock: String(variant.stock),
    loadedStock: String(variant.stock),
    image: variant.image ?? "",
    allowBackorder: variant.allowBackorder,
    isDefault: variant.isDefault,
  };
}

/**
 * A new variant's price/stock default to the base product's — this is only
 * the initial value shown in the "add variant" form, not a live sync, so
 * editing the base product afterward never touches variants that already
 * exist (including ones the admin has manually overridden).
 */
function newVariantForm(basePrice: number, baseStock: number): VariantFormState {
  return {
    name: "",
    sku: "",
    price: String(basePrice),
    optionsJson: '{"Color":""}',
    stock: String(baseStock),
    image: "",
    allowBackorder: false,
    isDefault: false,
  };
}

function VariantFieldsGrid({
  form,
  onChange,
}: {
  form: VariantFormState;
  onChange: (form: VariantFormState) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Input placeholder="Name (e.g. Terracotta / M)" value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
      <Input placeholder="SKU" value={form.sku} onChange={(e) => onChange({ ...form, sku: e.target.value })} />
      <Input placeholder="Price" type="number" step="0.01" value={form.price} onChange={(e) => onChange({ ...form, price: e.target.value })} />
      <Input placeholder="Stock" type="number" value={form.stock} onChange={(e) => onChange({ ...form, stock: e.target.value })} />
      <Input placeholder="Image URL (optional)" value={form.image} onChange={(e) => onChange({ ...form, image: e.target.value })} />
      <Input
        placeholder='Options JSON, e.g. {"Color":"Terracotta"}'
        value={form.optionsJson}
        onChange={(e) => onChange({ ...form, optionsJson: e.target.value })}
      />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={form.allowBackorder} onCheckedChange={(c) => onChange({ ...form, allowBackorder: !!c })} />
        Allow backorder
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={form.isDefault} onCheckedChange={(c) => onChange({ ...form, isDefault: !!c })} />
        Default variant
      </label>
    </div>
  );
}

export function ProductVariantsManager({
  productId,
  variants,
  basePrice,
  baseStock,
}: {
  productId: string;
  variants: ProductVariant[];
  basePrice: number;
  baseStock: number;
}) {
  const [addForm, setAddForm] = useState<VariantFormState>(() => newVariantForm(basePrice, baseStock));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<VariantFormState | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Unsaved = a touched "add" form, or an open edit form that differs from the stored variant.
  const addDirty = JSON.stringify(addForm) !== JSON.stringify(newVariantForm(basePrice, baseStock));
  const original = editingId ? variants.find((v) => v.id === editingId) : undefined;
  const editDirty = !!(editForm && original && JSON.stringify(editForm) !== JSON.stringify(variantToForm(original)));
  useReportDirty("variants", addDirty || editDirty || isPending);

  function submitVariant(variantId: string | null, form: VariantFormState, onSuccess: () => void) {
    startTransition(async () => {
      const result = await saveVariantAction(productId, variantId, {
        ...form,
        price: Number(form.price),
        stock: Number(form.stock),
        loadedStock: variantId && form.loadedStock !== undefined ? Number(form.loadedStock) : undefined,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(variantId ? "Variant updated" : "Variant added");
      onSuccess();
      router.refresh();
    });
  }

  function handleAdd() {
    submitVariant(null, addForm, () => setAddForm(newVariantForm(basePrice, baseStock)));
  }

  function startEdit(variant: ProductVariant) {
    setEditingId(variant.id);
    setEditForm(variantToForm(variant));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
  }

  function handleSaveEdit() {
    if (!editingId || !editForm) return;
    submitVariant(editingId, editForm, () => {
      setEditingId(null);
      setEditForm(null);
    });
  }

  function handleDelete(variantId: string) {
    startTransition(async () => {
      const result = await deleteVariantAction(variantId, productId);
      if (!result.success) toast.error(result.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {variants.length > 0 && (
        <div className="space-y-3">
          {variants.map((variant) =>
            editingId === variant.id && editForm ? (
              <div key={variant.id} className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
                <VariantFieldsGrid form={editForm} onChange={setEditForm} />
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={handleSaveEdit} disabled={isPending}>
                    <Check className="size-4" /> Save
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={cancelEdit} disabled={isPending}>
                    <X className="size-4" /> Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div
                key={variant.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-4">
                  <span className="font-medium">
                    {variant.name} {variant.isDefault && "★"}
                  </span>
                  <span className="text-muted-foreground">{variant.sku}</span>
                  <span>{formatPrice(Number(variant.price))}</span>
                  <span className="text-muted-foreground">Stock: {variant.stock}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => startEdit(variant)} aria-label="Edit variant">
                    <Pencil className="size-4 text-muted-foreground hover:text-foreground" />
                  </button>
                  <button type="button" onClick={() => handleDelete(variant.id)} aria-label="Delete variant">
                    <Trash2 className="size-4 text-destructive" />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-dashed border-border p-4">
        <p className="text-sm font-medium text-muted-foreground">Add a new variant</p>
        <VariantFieldsGrid form={addForm} onChange={setAddForm} />
        <Button type="button" onClick={handleAdd} disabled={isPending}>Add variant</Button>
      </div>
    </div>
  );
}
