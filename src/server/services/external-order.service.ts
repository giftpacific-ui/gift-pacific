import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { generateOrderNumber } from "@/lib/order-number";
import { computeExternalTotals, externalPaymentStatus, parseExternalOrderInput, COST_KINDS, type CostKindName } from "@/lib/external-order";
import { expectedPayoutPaisa, settlementState } from "@/lib/settlement";
import { toPaisa } from "@/lib/money";
import { recordCodCollection } from "@/server/services/advance.service";
import { refreshSettlementStatus } from "@/server/services/settlement.service";
import { resolveCombo, buildComboSnapshot, demandKey } from "@/lib/combo";
import { recordPlacementMovements, reserveStockForLine, type StockLine } from "@/server/services/order-inventory";
import { loadComboTemplates } from "@/server/services/combo.service";
import { nextOrderSequence } from "@/server/services/order.service";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const uniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
/** Which unique rule fired, so the admin is told the truth (a reused wallet transaction id is not "someone else recorded this order"). */
const violatedTransactionRef = (e: unknown) => { const x = e as { meta?: { target?: unknown }; message?: string }; return /providerRef/.test(`${JSON.stringify(x?.meta?.target ?? "")} ${x?.message ?? ""}`); };

/**
 * Records a sale made on a marketplace. This is its OWN code path: it never calls
 * placeOrder(), so it cannot create a cart, apply a coupon, take payment, send a
 * notification, fire a tracking/purchase event, or book a courier.
 *
 * Stock policy per order:
 *   DEDUCT (default) — the same guarded, sorted stock decrements as website checkout; what was
 *                      taken is recorded per line, so cancel/return restores exactly that.
 *   NONE             — nothing is taken (stock already adjusted / held by the marketplace);
 *                      nothing is recorded as deducted, so nothing is ever restored.
 * Prices and costs are what the admin ENTERED; nothing is estimated or invented.
 *
 * Money rules (see src/lib/accounting.ts):
 *   - an ADVANCE is verified money received directly by us: ONE Payment row (unique per method + normalised transaction id) and
 *     Order.advancePaid. A partial advance NEVER makes the order PAID.
 *   - a marketplace PAYOUT is only counted once a person records the amount and date actually received (MarketplaceSettlement row);
 *     expected payout = total − advance − commission/payment fee. Nothing is assumed settled.
 */
export async function createExternalOrder(raw: unknown, adminId: string | null) {
  const parsed = parseExternalOrderInput(raw);
  if (!parsed.ok) throw new UserFacingError(parsed.message);
  const input = parsed.value;

  const channel = await prisma.salesChannel.findUnique({ where: { id: input.channelId } });
  if (!channel || !channel.isActive || channel.kind === "WEBSITE") {
    throw new UserFacingError("Choose an active marketplace or external channel.");
  }
  const duplicate = await prisma.order.findFirst({
    where: { channelId: channel.id, externalOrderRef: input.externalOrderRef },
    select: { orderNumber: true },
  });
  if (duplicate) {
    throw new UserFacingError(`${channel.name} order ${input.externalOrderRef} is already recorded as ${duplicate.orderNumber}.`);
  }

  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, include: { variants: true } });
  const templates = await loadComboTemplates(prisma, products.filter((p) => p.kind === "COMBO").map((p) => p.id));

  type Line = {
    item: (typeof input.items)[number];
    product: (typeof products)[number];
    variant: (typeof products)[number]["variants"][number] | null;
    components: { slotLabel: string | null; productId: string; variantId: string | null; productName: string; variantName: string | null; quantity: number; unitPrice: number; unitCost: number | null; trackInventory: boolean; allowBackorder: boolean }[];
    componentPolicy: boolean;
    comboSnapshot: ReturnType<typeof buildComboSnapshot> | null;
    /** Server-calculated price of one combo (reference only: the entered marketplace price is what is charged). */
    computedUnitPrice: number | null;
    /** Sum of component costs when every one is known (same rule as website checkout). */
    comboUnitCost: number | null;
  };
  const lines: Line[] = input.items.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    if (!product) throw new UserFacingError("A product in this order no longer exists.");
    if (product.kind === "COMBO") {
      const template = templates.get(product.id);
      if (!template) throw new UserFacingError(`"${product.name}" has no valid combo configuration.`);
      // Same validation as checkout: FIXED takes no selections; CUSTOMIZABLE needs valid ones.
      const resolved = resolveCombo(template, template.mode === "FIXED" ? (item.selections?.length ? item.selections : undefined) : item.selections ?? []);
      if (!resolved.ok) throw new UserFacingError(`"${product.name}": ${resolved.message}`);
      const comps = resolved.value.components;
      return {
        item, product, variant: null, componentPolicy: template.stockPolicy === "COMPONENTS",
        comboSnapshot: { ...buildComboSnapshot(template, resolved.value), source: "external" } as never,
        computedUnitPrice: resolved.value.unitPrice,
        comboUnitCost: comps.every((c) => c.unitCost !== null) ? round2(comps.reduce((sum, c) => sum + (c.unitCost ?? 0) * c.quantity, 0)) : null,
        components: comps.map((c) => ({
          slotLabel: c.slotLabel, productId: c.productId, variantId: c.variantId, productName: c.productName, variantName: c.variantName,
          quantity: c.quantity, unitPrice: c.unitPrice, unitCost: c.unitCost, trackInventory: c.trackInventory, allowBackorder: c.allowBackorder,
        })),
      };
    }
    let variant: Line["variant"] = null;
    if (product.type === "VARIANT") {
      variant = product.variants.find((v) => v.id === item.variantId) ?? null;
      if (!variant) throw new UserFacingError(`Choose an option for "${product.name}".`);
    } else if (item.variantId) {
      throw new UserFacingError(`"${product.name}" has no options.`);
    }
    return { item, product, variant, components: [], componentPolicy: false, comboSnapshot: null, computedUnitPrice: null, comboUnitCost: null };
  });

  const totals = computeExternalTotals(input.items, input.shippingTotal, input.discountTotal);
  const settings = await prisma.storeSettings.findUnique({ where: { id: "singleton" }, select: { currencyCode: true } });
  // Marketplace payout: expected = total − advance − fees withheld; received = only what was entered. Never assumed.
  if (input.settlementReceived > 0 && channel.kind !== "MARKETPLACE") throw new UserFacingError("A marketplace payout can only be recorded for a marketplace channel.");
  const expectedPayout = channel.kind === "MARKETPLACE" ? expectedPayoutPaisa({ total: totals.total, advancePaid: input.advanceReceived, costLines: input.costLines }) : 0;
  const settlementStatus = channel.kind === "MARKETPLACE" ? settlementState(expectedPayout, toPaisa(input.settlementReceived)) : "NOT_APPLICABLE";
  const snapshot = { fullName: input.customer.fullName, phone: input.customer.phone, line1: input.customer.line1, city: input.customer.city ?? null, country: "BD" };

  try {
    return await prisma.$transaction(async (tx) => {
      // A wallet transaction can only ever be counted once, across every order (normalised, case-insensitive).
      if (input.advanceReceived > 0 && input.advanceReference) {
        const used = await tx.payment.findFirst({ where: { method: input.advanceMethod, providerRef: { equals: input.advanceReference, mode: "insensitive" } }, select: { orderId: true } });
        if (used) {
          const other = await tx.order.findUnique({ where: { id: used.orderId }, select: { orderNumber: true } });
          throw new UserFacingError(`Transaction ${input.advanceReference} (${input.advanceMethod}) has already been recorded${other ? ` on order ${other.orderNumber}` : ""}. One payment can only be counted once.`);
        }
      }
      // Stock: guarded decrements in sorted (product, variant) order, exactly like checkout.
      const deducted = new Map<number, number>();
      const procured = new Map<number, number>();
      const compDeducted = new Map<string, number>();
      const compProcured = new Map<string, number>();
      if (input.stockPolicy === "DEDUCT") {
        type Op = { key: string; lineIndex: number; compIndex: number | null; stock: StockLine };
        const ops: Op[] = [];
        lines.forEach((l, lineIndex) => {
          if (l.componentPolicy) {
            l.components.forEach((c, compIndex) =>
              ops.push({ key: demandKey(c), lineIndex, compIndex, stock: { productId: c.productId, variantId: c.variantId, quantity: c.quantity * l.item.quantity, productName: c.productName, trackInventory: c.trackInventory, allowBackorder: c.allowBackorder } }),
            );
          } else {
            ops.push({
              key: demandKey({ productId: l.product.id, variantId: l.variant?.id ?? null }), lineIndex, compIndex: null,
              stock: { productId: l.product.id, variantId: l.variant?.id ?? null, quantity: l.item.quantity, productName: l.product.name, trackInventory: l.product.trackInventory, allowBackorder: l.variant ? l.variant.allowBackorder : l.product.allowBackorder, procurementLimit: l.variant ? l.variant.procurementLimit : l.product.procurementLimit },
            });
          }
        });
        ops.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (const op of ops) {
          const reservation = await reserveStockForLine(tx, op.stock);
          if (op.compIndex === null) {
            deducted.set(op.lineIndex, reservation.deducted);
            procured.set(op.lineIndex, reservation.procurement);
          } else {
            compDeducted.set(`${op.lineIndex}:${op.compIndex}`, reservation.deducted);
            compProcured.set(`${op.lineIndex}:${op.compIndex}`, reservation.procurement);
          }
        }
      }

      const orderNumber = await generateOrderNumber(() => nextOrderSequence(tx));
      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          userId: null,
          email: input.customer.email || null,
          phone: input.customer.phone,
          status: input.status,
          // A label only (never cash). A verified partial advance is PARTIALLY_PAID, not PAID — whatever the form said.
          paymentStatus: externalPaymentStatus(channel.kind, totals.total, input.advanceReceived, input.paymentStatus),
          advancePaid: input.advanceReceived,
          settlementStatus,
          settledAt: settlementStatus === "SETTLED" ? new Date() : null,
          paymentMethod: "MARKETPLACE",
          shippingSnapshot: snapshot,
          billingSnapshot: snapshot,
          subtotal: totals.subtotal,
          discountTotal: input.discountTotal,
          shippingTotal: input.shippingTotal,
          taxTotal: 0,
          total: totals.total,
          currency: settings?.currencyCode ?? "BDT",
          channelId: channel.id,
          externalOrderRef: input.externalOrderRef,
          externalPlacedAt: input.externalPlacedAt ? new Date(input.externalPlacedAt) : null,
          fulfillmentMode: input.fulfillmentMode,
          createdById: adminId,
          customerNote: input.note ?? null,
          items: {
            create: lines.map((l, lineIndex) => ({
              productId: l.product.id,
              variantId: l.variant?.id ?? null,
              productName: l.product.name,
              variantName: l.variant?.name ?? null,
              imageUrl: l.variant?.image ?? null,
              unitPrice: l.item.unitPrice,
              quantity: l.item.quantity,
              lineTotal: round2(l.item.unitPrice * l.item.quantity),
              // An entered cost wins; otherwise the catalogue cost, otherwise unknown (never guessed).
              unitCost: l.item.unitCost ?? (l.comboUnitCost ?? (l.product.costPrice === null ? null : Number(l.product.costPrice))),
              stockDeducted: deducted.get(lineIndex) ?? 0,
              procurementQty: procured.get(lineIndex) ?? 0,
              ...(l.components.length > 0
                ? {
                    comboSnapshot: l.comboSnapshot as Prisma.InputJsonValue,
                    components: {
                      create: l.components.map((c, compIndex) => ({
                        slotLabel: c.slotLabel, productId: c.productId, variantId: c.variantId, productName: c.productName, variantName: c.variantName,
                        quantity: c.quantity, unitPrice: c.unitPrice, unitCost: c.unitCost, stockDeducted: compDeducted.get(`${lineIndex}:${compIndex}`) ?? 0,
                        procurementQty: compProcured.get(`${lineIndex}:${compIndex}`) ?? 0,
                      })),
                    },
                  }
                : {}),
            })),
          },
          ...(input.advanceReceived > 0
            ? { payments: { create: { method: input.advanceMethod, status: "PAID", kind: "ADVANCE", amount: input.advanceReceived, currency: settings?.currencyCode ?? "BDT", providerRef: input.advanceReference || null, customerReference: input.advanceReference || null, verifiedById: adminId, verifiedAt: new Date() } } }
            : {}),
          ...(input.settlementReceived > 0
            ? { settlements: { create: { amount: input.settlementReceived, receivedOn: new Date(`${input.settlementReceivedOn}T00:00:00.000Z`), reference: input.settlementReference, note: "Recorded when the order was entered", recordedById: adminId } } }
            : {}),
          costLines: { create: input.costLines.map((c) => ({ kind: c.kind, amount: c.amount, note: c.note || null, enteredById: adminId })) },
          trackingEvents: { create: { status: input.status, note: `Recorded from ${channel.name} (${input.externalOrderRef})` } },
        },
        select: { id: true, orderNumber: true },
      });
      // An order entered as already DELIVERED (non-marketplace) collected its COD balance: record it like the live flow does.
      if (input.status === "DELIVERED") await recordCodCollection(tx, createdOrder.id);
      // Same ledger as an ordinary order: what this order took from stock, and why.
      await recordPlacementMovements(tx, createdOrder.id, adminId);
      return createdOrder;
    });
  } catch (error) {
    // Two admins entering the same marketplace order at once: the unique index lets one through.
    if (uniqueViolation(error)) {
      if (violatedTransactionRef(error)) throw new UserFacingError(`Transaction ${input.advanceReference} (${input.advanceMethod}) was just recorded on another order. One payment can only be counted once.`);
      throw new UserFacingError(`${channel.name} order ${input.externalOrderRef} was just recorded by someone else.`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cost lines (only what somebody actually entered)
// ---------------------------------------------------------------------------
export async function adminAddOrderCostLine(orderId: string, input: { kind: string; amount: number; note?: string }, adminId: string | null) {
  if (!(COST_KINDS as readonly string[]).includes(input.kind)) throw new UserFacingError("Choose a cost type.");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000 || round2(amount) !== amount) throw new UserFacingError("Enter a valid amount (up to 2 decimals).");
  await prisma.$transaction(async (tx) => {
    if (!(await tx.order.findUnique({ where: { id: orderId }, select: { id: true } }))) throw new UserFacingError("Order not found.");
    await tx.orderCostLine.create({ data: { orderId, kind: input.kind as CostKindName, amount, note: input.note?.trim().slice(0, 200) || null, enteredById: adminId } });
    // Commission / payment fee change what the marketplace is expected to pay: keep the receivable status in step.
    await refreshSettlementStatus(tx, orderId);
  });
}

export async function adminDeleteOrderCostLine(orderId: string, lineId: string) {
  await prisma.$transaction(async (tx) => {
    const res = await tx.orderCostLine.deleteMany({ where: { id: lineId, orderId } });
    if (res.count > 0) await refreshSettlementStatus(tx, orderId);
  });
}

export async function adminListOrderCostLines(orderId: string) {
  const lines = await prisma.orderCostLine.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  return lines.map((l) => ({ id: l.id, kind: l.kind, amount: Number(l.amount), note: l.note }));
}

// ---------------------------------------------------------------------------
// Channels and expenses
// ---------------------------------------------------------------------------
export async function adminListChannels() {
  return prisma.salesChannel.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] });
}

export async function adminSaveChannel(id: string | null, input: { name: string; kind: "MARKETPLACE" | "OTHER"; isActive: boolean }) {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new UserFacingError("Channel name is required (max 60 characters).");
  if (input.kind !== "MARKETPLACE" && input.kind !== "OTHER") throw new UserFacingError("Invalid channel type.");
  if (id) {
    const current = await prisma.salesChannel.findUnique({ where: { id } });
    if (!current) throw new UserFacingError("Channel not found.");
    if (current.kind === "WEBSITE") throw new UserFacingError("The website channel cannot be edited.");
    await prisma.salesChannel.update({ where: { id }, data: { name, kind: input.kind, isActive: input.isActive } });
    return;
  }
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "channel";
  let key = base;
  for (let i = 2; await prisma.salesChannel.findUnique({ where: { key }, select: { id: true } }); i++) key = `${base}-${i}`;
  await prisma.salesChannel.create({ data: { key, name, kind: input.kind, isActive: input.isActive } });
}

export async function adminListExpenses(fromDay: string, toDay: string) {
  const rows = await prisma.expense.findMany({
    where: { spentOn: { gte: new Date(`${fromDay}T00:00:00.000Z`), lte: new Date(`${toDay}T00:00:00.000Z`) } },
    orderBy: [{ spentOn: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  return rows.map((e) => ({ id: e.id, spentOn: e.spentOn.toISOString().slice(0, 10), category: e.category, amount: Number(e.amount), channelId: e.channelId, note: e.note }));
}

export async function adminAddExpense(input: { spentOn: string; category: string; amount: number; channelId?: string | null; note?: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn) || Number.isNaN(new Date(`${input.spentOn}T00:00:00Z`).getTime())) throw new UserFacingError("Enter a valid date.");
  const category = input.category.trim();
  if (!category || category.length > 60) throw new UserFacingError("Category is required (max 60 characters).");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 || round2(amount) !== amount) throw new UserFacingError("Enter a valid amount (up to 2 decimals).");
  if (input.channelId && !(await prisma.salesChannel.findUnique({ where: { id: input.channelId }, select: { id: true } }))) throw new UserFacingError("Unknown channel.");
  await prisma.expense.create({ data: { spentOn: new Date(`${input.spentOn}T00:00:00.000Z`), category, amount, channelId: input.channelId || null, note: input.note?.trim().slice(0, 300) || null } });
}

export async function adminDeleteExpense(id: string) {
  await prisma.expense.deleteMany({ where: { id } });
}

export { Prisma };
