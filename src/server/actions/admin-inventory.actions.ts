"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { receiveProcurement } from "@/server/services/procurement.service";
import { applyLegacyBackorderLinks } from "@/server/services/inventory-reconcile.service";

type Result = { success: true; message: string } | { success: false; message: string };

export async function receiveProcurementAction(input: { productId: string; variantId?: string | null; quantity: number; note?: string; totalCost?: number | null; idempotencyKey?: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    const r = await receiveProcurement({
      productId: String(input?.productId ?? ""),
      variantId: input?.variantId ? String(input.variantId) : null,
      quantity: Number(input?.quantity),
      adminId: admin.id,
      note: input?.note ?? null,
      idempotencyKey: typeof input?.idempotencyKey === "string" ? input.idempotencyKey : null,
      totalCost: input?.totalCost === null || input?.totalCost === undefined || (input.totalCost as unknown) === "" ? null : Number(input.totalCost),
    });
    for (const p of ["/admin/inventory", "/admin/orders", "/admin"]) revalidatePath(p);
    return { success: true, message: r.duplicate ? "That receipt was already recorded — nothing was changed." : `Recorded ${r.quantity} received: ${r.allocatedToOrders} reserved for waiting orders, ${r.addedToStock} added to stock.` };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not record the received goods.") };
  }
}

/** Applies the legacy-backorder link plan the admin reviewed (see HANDOFF_GIFTPACIFIC.md §12). Fails without changes if the data moved since the preview. */
export async function applyLegacyBackorderLinksAction(expectedUnits: number): Promise<Result> {
  const admin = await requireAdmin();
  try {
    const r = await applyLegacyBackorderLinks(admin.id, Number(expectedUnits));
    for (const p of ["/admin/inventory", "/admin/orders"]) revalidatePath(p);
    return { success: true, message: `Linked ${r.units} legacy backordered unit(s) across ${r.linkedLines} order line(s). Stock quantities were not changed.` };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not apply the reconciliation.") };
  }
}
