"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import {
  adminAddExpense,
  adminAddOrderCostLine,
  adminDeleteExpense,
  adminDeleteOrderCostLine,
  adminSaveChannel,
  createExternalOrder,
} from "@/server/services/external-order.service";

type Result = { success: true; id?: string; orderNumber?: string } | { success: false; message: string };

export async function createExternalOrderAction(raw: unknown): Promise<Result> {
  const admin = await requireAdmin();
  try {
    const order = await createExternalOrder(raw, admin.id);
    revalidatePath("/admin/orders");
    revalidatePath("/admin/reports");
    revalidatePath("/admin/accounts");
    revalidatePath("/admin");
    return { success: true, id: order.id, orderNumber: order.orderNumber };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not record the order.") };
  }
}

export type OrderProductHit = {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  kind: "SINGLE" | "COMBO";
  customizable: boolean;
  variants: { id: string; name: string; price: number }[];
};

export async function searchProductsForOrderAction(query: string): Promise<OrderProductHit[]> {
  await requireAdmin();
  const q = String(query ?? "").trim().slice(0, 80);
  if (q.length < 2) return [];
  const rows = await prisma.product.findMany({
    where: { name: { contains: q, mode: "insensitive" }, status: { not: "ARCHIVED" } },
    select: { id: true, name: true, price: true, costPrice: true, kind: true, comboMode: true, variants: { select: { id: true, name: true, price: true }, orderBy: { name: "asc" } } },
    take: 10,
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price),
    costPrice: r.costPrice === null ? null : Number(r.costPrice),
    kind: r.kind,
    customizable: r.comboMode === "CUSTOMIZABLE",
    variants: r.variants.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
  }));
}

async function run(fn: () => Promise<void>, fallback: string, paths: string[]): Promise<Result> {
  await requireAdmin();
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, fallback) };
  }
}

export async function addOrderCostAction(orderId: string, input: { kind: string; amount: number; note?: string }): Promise<Result> {
  const admin = await requireAdmin();
  return run(() => adminAddOrderCostLine(orderId, input, admin.id), "Could not add the cost.", [`/admin/orders/${orderId}`, "/admin/reports/channels"]);
}
export async function deleteOrderCostAction(orderId: string, lineId: string) {
  return run(() => adminDeleteOrderCostLine(orderId, lineId), "Could not delete the cost.", [`/admin/orders/${orderId}`, "/admin/reports/channels"]);
}
export async function saveChannelAction(id: string | null, input: { name: string; kind: "MARKETPLACE" | "OTHER"; isActive: boolean }) {
  return run(() => adminSaveChannel(id, input), "Could not save the channel.", ["/admin/channels", "/admin/orders"]);
}
export async function addExpenseAction(input: { spentOn: string; category: string; amount: number; channelId?: string | null; note?: string }) {
  return run(() => adminAddExpense(input), "Could not add the expense.", ["/admin/expenses", "/admin/reports/channels"]);
}
export async function deleteExpenseAction(id: string) {
  return run(() => adminDeleteExpense(id), "Could not delete the expense.", ["/admin/expenses", "/admin/reports/channels"]);
}

// ---------------------------------------------------------------------------
// Customizable combos in manual orders: picker data + server price preview.
// Display/preview only; createExternalOrder() re-validates everything.
// ---------------------------------------------------------------------------
export type ComboPickerData = {
  mode: "FIXED" | "CUSTOMIZABLE";
  slots: { id: string; label: string; minSelect: number; maxSelect: number; maxPerOption: number; options: { id: string; name: string; variantName: string | null }[] }[];
};

export async function getComboPickerAction(productId: string): Promise<ComboPickerData | null> {
  await requireAdmin();
  const { loadComboTemplates } = await import("@/server/services/combo.service");
  const template = (await loadComboTemplates(prisma, [String(productId)])).get(String(productId));
  if (!template) return null;
  return {
    mode: template.mode,
    slots: template.slots.map((s) => ({
      id: s.id, label: s.label, minSelect: s.minSelect, maxSelect: s.maxSelect, maxPerOption: s.maxPerOption,
      options: s.options.map((o) => ({ id: o.id, name: o.product.name, variantName: o.variantId ? o.product.variants.find((v) => v.id === o.variantId)?.name ?? null : null })),
    })),
  };
}

export async function previewComboPriceAction(productId: string, selections: unknown): Promise<{ ok: true; unitPrice: number } | { ok: false; message: string }> {
  await requireAdmin();
  const [{ loadComboTemplates }, { resolveCombo }] = await Promise.all([import("@/server/services/combo.service"), import("@/lib/combo")]);
  const template = (await loadComboTemplates(prisma, [String(productId)])).get(String(productId));
  if (!template) return { ok: false, message: "Combo not found." };
  const r = resolveCombo(template, template.mode === "FIXED" ? undefined : selections);
  return r.ok ? { ok: true, unitPrice: r.value.unitPrice } : { ok: false, message: r.message };
}
