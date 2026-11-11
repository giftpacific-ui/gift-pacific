"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { recordSettlement } from "@/server/services/settlement.service";
import { listGoodsStillOut, recordIncident, type IncidentFormInput } from "@/server/services/incident.service";
import { prisma } from "@/lib/db/prisma";

type Result = { success: true } | { success: false; message: string };

export async function recordIncidentAction(input: IncidentFormInput): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await recordIncident({
      kind: input?.kind, occurredOn: String(input?.occurredOn ?? ""), orderId: input?.orderId || null, orderItemId: input?.orderItemId || null,
      productId: input?.productId || null, variantId: input?.variantId || null, quantity: Number(input?.quantity ?? 0), stockEffect: input?.stockEffect ?? "NONE",
      lossAmount: Number(input?.lossAmount ?? 0), refundAmount: Number(input?.refundAmount ?? 0), courierFee: Number(input?.courierFee ?? 0), note: input?.note ?? null,
      idempotencyKey: typeof input?.idempotencyKey === "string" ? input.idempotencyKey : null,
    }, admin.id);
    for (const p of ["/admin/accounts", "/admin", "/admin/inventory"]) revalidatePath(p);
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not record that.") }; }
}

/** Looks up an order by its number so the form can offer its lines (read-only, admin only). */
export async function lookupOrderLinesAction(orderNumber: string) {
  await requireAdmin();
  const o = await prisma.order.findUnique({
    where: { orderNumber: String(orderNumber ?? "").trim() },
    select: { id: true, orderNumber: true, status: true },
  });
  if (!o) return null;
  // Per line: how many units are still out (can be put back / marked unsellable). 0 for orders whose goods never left.
  const out = new Map((await listGoodsStillOut(o.id)).map((x) => [x.lineId, x.remaining]));
  const items = await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { id: true, productName: true, quantity: true } });
  return { id: o.id, orderNumber: o.orderNumber, status: o.status, items: items.map((i) => ({ ...i, stillOut: out.get(i.id) ?? 0 })) };
}

/**
 * Records a marketplace payout that ACTUALLY arrived (amount + date + reference). Partial payouts are fine: the rest stays receivable.
 * `idempotencyKey` makes a double-click or retry a no-op.
 */
export async function recordSettlementAction(input: { orderId: string; amount: number; receivedOn: string; reference?: string; idempotencyKey?: string; note?: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await recordSettlement({
      orderId: String(input?.orderId ?? ""), amount: Number(input?.amount), receivedOn: String(input?.receivedOn ?? ""),
      reference: input?.reference ?? null, idempotencyKey: input?.idempotencyKey ?? null, note: input?.note ?? null,
    }, admin.id);
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not record the payout.") }; }
  for (const p of ["/admin/accounts", "/admin", "/admin/reports/channels"]) revalidatePath(p);
  return { success: true };
}
