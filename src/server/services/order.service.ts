import "server-only";
import { quoteAdvance, assertDispatchReady, assertServiceActor, fraudEvidence, recordCodCollection, type ServiceActor } from "@/server/services/advance.service";
import { quoteDeliveryReward } from "@/lib/rewards";
import { issueRewardForDeliveredOrder, releaseRewardUsedBy, revokeRewardEarnedBy } from "@/server/services/reward.service";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { getOrCreateCartForCurrentVisitor } from "@/server/services/cart.service";
import { validateCoupon } from "@/server/services/coupon.service";
import { getDeliveryCharge } from "@/server/services/delivery.service";
import {
  isValidQuantity,
  maxOrderableQuantity,
  resolveLineStock,
  totalQuantityFor,
  validateVariantSelection,
} from "@/lib/stock";
import {
  sellableCustomizationFields,
  validateCustomizationInput,
} from "@/lib/customization";
import { assertPaymentMethodEnabled } from "@/lib/payment-methods";
import { generateOrderNumber } from "@/lib/order-number";
import {
  assertTransition,
  isOrderStatus,
  shouldReleaseStock,
} from "@/lib/order-transitions";
import { ITEM_INTERNAL_FIELDS, ORDER_INTERNAL_FIELDS } from "@/lib/order-visibility";
import { releaseModeFor } from "@/lib/inventory-rules";
import { UserFacingError } from "@/lib/errors";
import { orderStatusNotification } from "@/lib/notification-rules";
import { notifyUser } from "@/server/services/notification.service";
import {
  reserveStockForLine,
  outstandingProcurementForOrder,
  restoreOrderStock,
  recordPlacementMovements,
  type StockLine,
} from "@/server/services/order-inventory";
import { recordEligibilityChange } from "@/server/services/admin-review.service";
import { resolveCartLines, assertDemandFits } from "@/server/services/combo.service";
import { buildComboSnapshot, demandKey } from "@/lib/combo";
import type {
  OrderStatus,
  PaymentMethod,
  DeliveryZone,
  Prisma,
} from "@prisma/client";

export type CheckoutAddressInput = {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
};

export type PlaceOrderInput = {
  email: string;
  phone: string;
  shippingAddress: CheckoutAddressInput;
  billingAddress?: CheckoutAddressInput | null;
  billingSameAsShipping: boolean;
  paymentMethod: PaymentMethod;
  deliveryZone: DeliveryZone;
  couponCode?: string | null;
  /** Opt-in: a delivery reward owned by the signed-in customer. Eligibility and amount are decided here, never by the client. */
  rewardId?: string | null;
  /** Where the customer says they sent the advance. Only a CLAIM: staff verify it before it counts. */
  advanceMethod?: "BKASH" | "NAGAD" | null;
  advanceReference?: string | null;
  customerNote?: string | null;
  saveAddressId?: string | null;
};

export async function nextOrderSequence(
  tx: Prisma.TransactionClient,
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ n: bigint | number | string }[]>`
    SELECT nextval('order_number_seq') AS n
  `;
  const n = rows[0]?.n;
  if (n === undefined || n === null)
    throw new Error("Could not allocate an order number.");
  return BigInt(n);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function getStoreSettingsOrDefaults() {
  const settings = await prisma.storeSettings.findUnique({
    where: { id: "singleton" },
  });
  return (
    settings ?? {
      shippingFlatRate: 0 as unknown as Prisma.Decimal,
      freeShippingThreshold: null,
      taxRatePercent: 0 as unknown as Prisma.Decimal,
      currencyCode: "BDT",
    }
  );
}

export async function placeOrder(input: PlaceOrderInput) {
  assertPaymentMethodEnabled(input.paymentMethod);

  const session = await getSession();
  const cart = await getOrCreateCartForCurrentVisitor();

  const cartItems = await prisma.cartItem.findMany({
    where: { cartId: cart.id },
    include: {
      product: {
        include: {
          images: { where: { isMain: true }, take: 1 },
          customizationFields: { orderBy: { sortOrder: "asc" } },
          variants: true,
        },
      },
      variant: true,
      selections: true,
    },
  });

  if (cartItems.length === 0) {
    throw new UserFacingError("Your cart is empty.");
  }

  const validatedCustomization = new Map<
    string,
    Record<string, string> | null
  >();
  for (const item of cartItems) {
    const name = item.product.name;
    if (item.product.status !== "ACTIVE") {
      throw new UserFacingError(
        `"${name}" is no longer available. Please remove it from your cart.`,
      );
    }
    if (!isValidQuantity(item.quantity)) {
      throw new UserFacingError(`Please check the quantity of "${name}".`);
    }
    const selectionError = validateVariantSelection({
      productType: item.product.type,
      variantId: item.variantId,
      variantBelongsToProduct:
        item.variant !== null && item.variant.productId === item.productId,
    });
    if (selectionError) {
      throw new UserFacingError(
        `"${name}" is no longer available in the selected option. Please remove it from your cart.`,
      );
    }
    const customization = validateCustomizationInput(
      sellableCustomizationFields(item.product),
      item.customization,
    );
    if (!customization.ok)
      throw new UserFacingError(`"${name}": ${customization.message}`);
    validatedCustomization.set(item.id, customization.value);
  }

  // Combos (and any single that is also a component) are resolved by the shared server-side
  // logic: price, availability and the stock demand of the WHOLE cart, counted together.
  const hasCombos = cartItems.some((i) => i.product.kind === "COMBO");
  const resolvedLines = hasCombos
    ? await resolveCartLines(
        prisma,
        cartItems.map((item) => ({
          id: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          product: item.product,
          variant: item.variant,
          selections: item.selections.map((sel) => ({ slotId: sel.slotId, optionId: sel.optionId, quantity: sel.quantity })),
        })),
      )
    : null;
  const resolvedById = new Map((resolvedLines ?? []).map((r) => [r.lineId, r]));
  if (resolvedLines) {
    for (const item of cartItems) {
      const reason = resolvedById.get(item.id)?.unavailableReason;
      if (reason) throw new UserFacingError(`"${item.product.name}": ${reason}`);
    }
    assertDemandFits(cartItems.map((item) => ({ quantity: item.quantity, resolved: resolvedById.get(item.id)! })));
  } else {
    for (const item of cartItems) {
      const fields = resolveLineStock({
        trackInventory: item.product.trackInventory,
        product: item.product,
        variant: item.variant,
      });
      const demand = totalQuantityFor(cartItems, item.productId, item.variantId);
      if (demand > maxOrderableQuantity(fields)) {
        throw new UserFacingError(
          fields.stock <= 0
            ? `"${item.product.name}" is out of stock.`
            : `"${item.product.name}" only has ${fields.stock} left in stock.`,
        );
      }
    }
  }

  // The server decides every price; a combo's price comes from its template + selection.
  const unitPriceOf = (item: (typeof cartItems)[number]) => {
    const r = resolvedById.get(item.id);
    if (r?.combo) return r.unitPrice;
    return item.variant ? Number(item.variant.price) : Number(item.product.price);
  };
  // Cost of ONE unit for later profit reporting. null = unknown; it is never invented.
  const unitCostOf = (item: (typeof cartItems)[number]): number | null => {
    const combo = resolvedById.get(item.id)?.combo;
    if (combo) {
      if (item.product.costPrice !== null) return Number(item.product.costPrice);
      const comps = combo.resolution.components;
      return comps.every((c) => c.unitCost !== null)
        ? round2(comps.reduce((sum, c) => sum + (c.unitCost ?? 0) * c.quantity, 0))
        : null;
    }
    return item.product.costPrice === null ? null : Number(item.product.costPrice);
  };
  // Immutable snapshot of what a combo contained and cost when it was bought.
  const componentDeducted = new Map<string, number>();
  const componentProcured = new Map<string, number>();
  const comboRecordFor = (it: (typeof cartItems)[number]) => {
    const combo = resolvedById.get(it.id)?.combo;
    if (!combo) return {};
    return {
      comboSnapshot: buildComboSnapshot(combo.template, combo.resolution),
      components: {
        create: combo.resolution.components.map((c, index) => ({
          slotLabel: c.slotLabel,
          productId: c.productId,
          variantId: c.variantId,
          productName: c.productName,
          variantName: c.variantName,
          quantity: c.quantity,
          unitPrice: c.unitPrice,
          unitCost: c.unitCost,
          stockDeducted: componentDeducted.get(`${it.id}:${index}`) ?? 0,
          // Units of a component accepted beyond stock are tracked on the component row, so they can be sourced and released.
          procurementQty: componentProcured.get(`${it.id}:${index}`) ?? 0,
        })),
      },
    };
  };

  const subtotal = round2(
    cartItems.reduce((sum, item) => sum + unitPriceOf(item) * item.quantity, 0),
  );

  const settings = await getStoreSettingsOrDefaults();

  let discountTotal = 0;
  let coupon: { id: string; usageLimit: number | null } | null = null;
  if (input.couponCode) {
    const result = await validateCoupon(
      input.couponCode,
      subtotal,
      session?.sub ?? null,
    );
    if (!result.valid) {
      throw new UserFacingError(result.message);
    }
    discountTotal = result.discountAmount;
    coupon = { id: result.coupon.id, usageLimit: result.coupon.usageLimit };
  }

  const freeShippingThreshold = settings.freeShippingThreshold
    ? Number(settings.freeShippingThreshold)
    : null;
  const zoneDeliveryCharge = await getDeliveryCharge(input.deliveryZone);
  const shippingTotal =
    freeShippingThreshold !== null &&
    subtotal - discountTotal >= freeShippingThreshold
      ? 0
      : zoneDeliveryCharge;

  // Optional delivery reward (opt-in). Server decides eligibility and the amount; consumption happens atomically in the transaction below.
  let reward: { id: string } | null = null;
  let deliveryDiscount = 0;
  if (input.rewardId) {
    if (!session) throw new UserFacingError("Please sign in to use a delivery reward.");
    const r = await prisma.customerReward.findFirst({ where: { id: input.rewardId, userId: session.sub } });
    if (!r || r.status !== "AVAILABLE" || (r.expiresAt && r.expiresAt <= new Date())) {
      throw new UserFacingError("That delivery reward is no longer available. Please remove it and try again.");
    }
    const quote = quoteDeliveryReward(
      { percent: r.percent, maxDiscount: r.maxDiscount == null ? null : Number(r.maxDiscount), minOrderAmount: Number(r.minOrderAmount), stackable: r.stackable },
      { deliveryCharge: shippingTotal, subtotalAfterCoupon: subtotal - discountTotal, couponApplied: Boolean(coupon) },
    );
    if (!quote.ok) {
      throw new UserFacingError(
        quote.reason === "below_minimum" ? "Your order is below the minimum for this delivery reward."
        : quote.reason === "no_stacking" ? "This delivery reward cannot be combined with a coupon."
        : "Delivery is already free, so the reward is not needed for this order.",
      );
    }
    deliveryDiscount = quote.discount;
    reward = { id: r.id };
  }
  const shippingBilled = round2(Math.max(shippingTotal - deliveryDiscount, 0));

  const taxableAmount = Math.max(subtotal - discountTotal, 0);
  const taxTotal = round2(
    taxableAmount * (Number(settings.taxRatePercent) / 100),
  );

  const total = round2(
    Math.max(subtotal - discountTotal + shippingBilled + taxTotal, 0),
  );

  // Advance / trust policy: decided here from OUR data. Nothing the browser sends can lower it.
  const advance = await quoteAdvance(prisma, { phone: input.shippingAddress.phone, zone: input.deliveryZone, orderTotal: total, address: input.shippingAddress });
  const advanceRequired = advance.decision.required;
  let advanceClaim: { method: "BKASH" | "NAGAD"; reference: string } | null = null;
  if (advanceRequired > 0) {
    const method = input.advanceMethod;
    const reference = (input.advanceReference ?? "").trim();
    if ((method !== "BKASH" && method !== "NAGAD") || reference.length < 4 || reference.length > 60) {
      throw new UserFacingError(`An advance of ${advanceRequired} is required for this delivery area. Send it as instructed and enter the wallet and transaction id.`);
    }
    advanceClaim = { method, reference };
  }
  const trustSnapshot = {
    score: advance.trust.score, insufficientEvidence: advance.trust.insufficientEvidence, reasons: advance.trust.reasons,
    // Fraud-check evidence behind the score (counts and status only; the phone number itself is not stored here).
    fraudCheck: fraudEvidence(advance.fraud.outcome, advance.fraud.phoneVerified, input.shippingAddress.phone),
    tier: advance.decision.tier, needsReview: advance.decision.needsReview, explanation: advance.decision.explanation,
    // Everything the decision was based on, frozen with the order: later policy or history changes never rewrite it.
    policy: { enabled: advance.settings.enabled, zones: advance.settings.zones, standard: advance.settings.standardAmount, reduced: advance.settings.reducedAmount, lowBelow: advance.settings.lowBelow, reducedFrom: advance.settings.reducedFrom, fullAt: advance.settings.fullAt, zeroAtFullTrust: advance.settings.zeroAtFullTrust, reviewEnabled: advance.settings.reviewEnabled },
    zone: { claimed: advance.claimedZone, applied: advance.policyZone, conflict: advance.zoneConflict },
    orderTotal: total, advanceRequired,
    settingsProblem: advance.settingsProblem,
    scoreMeaning: "Heuristic points 0-100 (higher = more confidence in successful fulfilment), derived only from the fraud-check record for the order phone (delivered history is credited only for a verified phone). Not a probability and not a fraud verdict.",
  };

  const shippingSnapshot = input.shippingAddress;
  const billingSnapshot = input.billingSameAsShipping
    ? input.shippingAddress
    : (input.billingAddress ?? input.shippingAddress);

  const order = await prisma.$transaction(async (tx) => {
    const claimed = await tx.cartItem.deleteMany({
      where: { id: { in: cartItems.map((i) => i.id) }, cartId: cart.id },
    });
    if (claimed.count !== cartItems.length) {
      throw new UserFacingError(
        "Your cart changed while checking out. Please review it and try again.",
      );
    }

    // Consume the reward in the SAME transaction as the order: a failed checkout rolls this back (reward stays available),
    // and two concurrent checkouts cannot both redeem it (only one UPDATE can match status AVAILABLE).
    if (reward) {
      const consumed = await tx.customerReward.updateMany({
        where: { id: reward.id, userId: session!.sub, status: "AVAILABLE" },
        data: { status: "USED", usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new UserFacingError("That delivery reward was just used on another order.");
    }

    // Every stock movement of the order, executed in SORTED (product, variant) order so
    // concurrent checkouts always take row locks in the same order (no lock-order
    // deadlocks). Exactly ONE inventory moves per line: the combo's own stock (OWN_STOCK)
    // or its components' stock (COMPONENTS) — never both.
    type StockOp = { key: string; itemId: string; componentIndex: number | null; line: StockLine };
    const ops: StockOp[] = [];
    for (const item of cartItems) {
      const combo = resolvedById.get(item.id)?.combo;
      if (combo && combo.template.stockPolicy === "COMPONENTS") {
        combo.resolution.components.forEach((c, index) => {
          ops.push({
            key: demandKey(c),
            itemId: item.id,
            componentIndex: index,
            line: {
              productId: c.productId,
              variantId: c.variantId,
              quantity: c.quantity * item.quantity,
              productName: c.productName,
              trackInventory: c.trackInventory,
              allowBackorder: c.allowBackorder,
            },
          });
        });
      } else {
        ops.push({
          key: demandKey({ productId: item.productId, variantId: item.variantId }),
          itemId: item.id,
          componentIndex: null,
          line: {
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            productName: item.product.name,
            trackInventory: item.product.trackInventory,
            allowBackorder: item.variant ? item.variant.allowBackorder : item.product.allowBackorder,
            procurementLimit: item.variant ? item.variant.procurementLimit : item.product.procurementLimit,
          },
        });
      }
    }
    ops.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const deducted = new Map<string, number>();
    const procured = new Map<string, number>();
    for (const op of ops) {
      const reservation = await reserveStockForLine(tx, op.line);
      if (op.componentIndex === null) {
        deducted.set(op.itemId, (deducted.get(op.itemId) ?? 0) + reservation.deducted);
        procured.set(op.itemId, (procured.get(op.itemId) ?? 0) + reservation.procurement);
      } else {
        componentDeducted.set(`${op.itemId}:${op.componentIndex}`, reservation.deducted);
        componentProcured.set(`${op.itemId}:${op.componentIndex}`, reservation.procurement);
      }
    }

    if (coupon) {
      if (coupon.usageLimit === null) {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { usageCount: { increment: 1 } },
        });
      } else {
        const used = await tx.coupon.updateMany({
          where: { id: coupon.id, usageCount: { lt: coupon.usageLimit } },
          data: { usageCount: { increment: 1 } },
        });
        if (used.count !== 1)
          throw new UserFacingError("This coupon has reached its usage limit.");
      }
    }

    const orderNumber = await generateOrderNumber(() => nextOrderSequence(tx));

    let shippingAddressId: string | null = null;
    let billingAddressId: string | null = null;

    if (session) {
      const savedShipping = await tx.address.create({
        data: {
          userId: session.sub,
          type: "SHIPPING",
          ...shippingAddressToRecord(input.shippingAddress),
        },
      });
      shippingAddressId = savedShipping.id;

      if (!input.billingSameAsShipping && input.billingAddress) {
        const savedBilling = await tx.address.create({
          data: {
            userId: session.sub,
            type: "BILLING",
            ...shippingAddressToRecord(input.billingAddress),
          },
        });
        billingAddressId = savedBilling.id;
      } else {
        billingAddressId = savedShipping.id;
      }
    }

    const created = await tx.order.create({
      data: {
        orderNumber,
        userId: session?.sub ?? null,
        email: input.email,
        phone: input.phone,
        status: "PENDING",
        paymentStatus: "UNPAID",
        paymentMethod: "COD",
        shippingAddressId,
        billingAddressId,
        shippingSnapshot,
        billingSnapshot,
        subtotal,
        discountTotal,
        shippingTotal: shippingBilled,
        deliveryDiscount,
        deliveryZone: input.deliveryZone,
        advanceRequired,
        trustScore: advance.trust.score,
        trustSnapshot,
        // Decided NOW from the policy in force; never recomputed from later history. Blocks confirm/dispatch until a staff member records a review.
        trustReviewRequired: advance.decision.needsReview,
        taxTotal,
        total,
        currency: settings.currencyCode,
        couponId: coupon?.id ?? null,
        customerNote: input.customerNote ?? null,
        items: {
          create: cartItems.map((item) => {
            const unitPrice = unitPriceOf(item);
            return {
              productId: item.productId,
              variantId: item.variantId,
              productName: item.product.name,
              variantName: item.variant?.name ?? null,
              imageUrl:
                item.variant?.image ?? item.product.images[0]?.url ?? null,
              unitPrice,
              quantity: item.quantity,
              lineTotal: round2(unitPrice * item.quantity),
              customization: validatedCustomization.get(item.id) ?? undefined,
              unitCost: unitCostOf(item),
              stockDeducted: deducted.get(item.id) ?? 0,
              procurementQty: procured.get(item.id) ?? 0,
              ...comboRecordFor(item),
            };
          }),
        },
        trackingEvents: {
          create: { status: "PENDING", note: "Order placed" },
        },
      },
    });
    // Audit trail of what this order took from stock (the units themselves were taken by the guarded updates above, in this transaction).
    await recordPlacementMovements(tx, created.id);
    if (reward) await tx.customerReward.update({ where: { id: reward.id }, data: { usedOrderId: created.id } });
    // The customer's claim is stored as PENDING with THEIR reference in customerReference (never in providerRef).
    if (advanceClaim) {
      await tx.payment.create({ data: { orderId: created.id, method: advanceClaim.method, status: "PENDING", kind: "ADVANCE", amount: advanceRequired, currency: settings.currencyCode, customerReference: advanceClaim.reference } });
    }
    return created;
  });

  return order;
}

function shippingAddressToRecord(address: CheckoutAddressInput) {
  return {
    fullName: address.fullName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2 || null,
    city: address.city,
    state: address.state || null,
    postalCode: address.postalCode || null,
    country: address.country,
  };
}

const orderDetailInclude = {
  items: {
    include: {
      product: { include: { images: { where: { isMain: true }, take: 1 } } },
      components: { orderBy: { id: "asc" as const } },
    },
  },
  trackingEvents: { orderBy: { createdAt: "asc" as const } },
  // Customer-safe columns only: never providerRef / customerReference / rawResponse / who verified.
  payments: {
    select: { id: true, method: true, kind: true, status: true, amount: true, verifiedAt: true, createdAt: true },
    orderBy: { createdAt: "asc" as const },
  },
  shippingAddress: true,
  billingAddress: true,
  coupon: true,
} satisfies Prisma.OrderInclude;

/** Courier bookkeeping that only admins see; customers get courierName / trackingNumber / trackingUrl only. */
const COURIER_INTERNAL_FIELDS = [
  "courierProvider",
  "courierConsignmentId",
  "courierBookingStatus",
  "courierBookingStartedAt",
  "courierBookedAt",
  "courierLastStatus",
  "courierLastEventAt",
  "courierLastError",
] as const;

/** Statuses an order may only enter once its advance (and any required review) is settled. */
const GATED_STATUSES: readonly string[] = ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

type RawOrderDetail = Prisma.OrderGetPayload<{
  include: typeof orderDetailInclude;
}>;

function without<T extends object, K extends keyof T>(
  obj: T,
  ...keys: K[]
): Omit<T, K> {
  const copy: Partial<T> = { ...obj };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

export function toCustomerOrder(order: RawOrderDetail) {
  return {
    ...without(order, "adminNote", "confirmationToken", "items", "coupon", "createdById", ...COURIER_INTERNAL_FIELDS, ...ORDER_INTERNAL_FIELDS),
    items: order.items.map((item) => ({
      // NEVER customer-visible: our cost, stock bookkeeping, the raw combo snapshot.
      ...without(item, "product", "components", ...ITEM_INTERNAL_FIELDS),
      // What a combo contained (names and quantities only — no costs, prices or ids).
      components: item.components.map((c) => ({
        slotLabel: c.slotLabel,
        productName: c.productName,
        variantName: c.variantName,
        quantity: c.quantity,
      })),
      product: item.product
        ? {
            slug: item.product.slug,
            images: item.product.images.map((i) => ({ url: i.url })),
          }
        : null,
    })),
    coupon: order.coupon ? { code: order.coupon.code } : null,
  };
}

export type OrderDetailData = ReturnType<typeof toCustomerOrder>;

export async function getOrderByNumberForCurrentUser(orderNumber: string) {
  const session = await getSession();
  if (!session) return null;
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: session.sub },
    include: orderDetailInclude,
  });
  return order ? toCustomerOrder(order) : null;
}

export async function getOrderForConfirmation(
  orderNumber: string,
  token?: string,
) {
  const session = await getSession();
  const order = await prisma.order.findFirst({
    where: { orderNumber },
    include: orderDetailInclude,
  });
  if (!order) return null;
  if (session && order.userId === session.sub) return toCustomerOrder(order);
  if (token && order.confirmationToken && order.confirmationToken === token)
    return toCustomerOrder(order);
  return null;
}

export async function getOrdersForCurrentUser() {
  const session = await getSession();
  if (!session) return [];
  const orders = await prisma.order.findMany({
    where: { userId: session.sub },
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
  return orders.map((order) => ({
    ...without(order, "adminNote", "confirmationToken", "items", "createdById", ...COURIER_INTERNAL_FIELDS, ...ORDER_INTERNAL_FIELDS),
    // Never customer-visible: our cost, stock bookkeeping, the raw combo snapshot.
    items: order.items.map((item) => without(item, ...ITEM_INTERNAL_FIELDS)),
  }));
}

export async function requestRefund(orderNumber: string, reason: string) {
  const session = await getSession();
  if (!session)
    throw new UserFacingError("Please sign in to request a refund.");

  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: session.sub },
    select: { id: true, status: true },
  });
  if (!order) throw new UserFacingError("Order not found.");
  if (order.status !== "DELIVERED") {
    throw new UserFacingError(
      "Refunds can only be requested for delivered orders.",
    );
  }
  assertTransition(order.status, "REFUND_REQUESTED");

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: "DELIVERED" },
      data: { status: "REFUND_REQUESTED" },
    });
    if (claimed.count !== 1) {
      throw new UserFacingError(
        "Refunds can only be requested for delivered orders.",
      );
    }
    await tx.orderTrackingEvent.create({
      data: { orderId: order.id, status: "REFUND_REQUESTED", note: reason },
    });
  });
}

export async function adminListOrders(params: {
  status?: OrderStatus;
  /** Courier booking state filter (NOT_BOOKED, BOOKING, BOOKED, FAILED, UNCERTAIN, MANUAL). */
  courier?: string;
  channelId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}) {
    const { status, search, channelId, courier, page = 1, pageSize = 20 } = params;
  const courierStates = ["NOT_BOOKED", "BOOKING", "BOOKED", "FAILED", "UNCERTAIN", "MANUAL"] as const;
  const where: Prisma.OrderWhereInput = {
    ...(status ? { status } : {}),
    ...(courier && (courierStates as readonly string[]).includes(courier) ? { courierBookingStatus: courier as (typeof courierStates)[number] } : {}),
    ...(channelId ? { channelId } : {}),
    ...(search
      ? {
          OR: [
                        { orderNumber: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { externalOrderRef: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        items: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return { items, total, page, pageCount: Math.ceil(total / pageSize) };
}

export async function adminGetOrderById(id: string) {
  return prisma.order.findUnique({
    where: { id },
    include: orderDetailInclude,
  });
}

export async function adminUpdateOrderStatus(
  orderId: string,
  status: OrderStatus,
  note: string | undefined,
  actor: ServiceActor,
) {
  // Authorisation first (before any validation or read): only an active ADMIN, or an internal courier-sync flow, may change an order's status.
  await assertServiceActor(prisma, actor);
  if (!isOrderStatus(status))
    throw new UserFacingError("Invalid order status.");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, userId: true, orderNumber: true },
    });
    if (!existing) throw new UserFacingError("Order not found.");

    assertTransition(existing.status, status);

    // The gate: an order that needs a VERIFIED advance (or a recorded waiver) and/or a recorded low-trust review cannot be confirmed, processed,
    // shipped or delivered until that is satisfied. It runs for EVERY move into those states, whatever the current state, so no path (server action,
    // courier webhook, direct service call) can skip it. Cancelling, failing a delivery and refund states are never blocked by it.
    if (GATED_STATUSES.includes(status)) await assertDispatchReady(tx, orderId);

    // An order with units still to be sourced is not ready to leave: block dispatch states until they arrive.
    if (status === "SHIPPED" || status === "OUT_FOR_DELIVERY" || status === "DELIVERED") {
      const waiting = await outstandingProcurementForOrder(tx, orderId);
      if (waiting > 0) {
        throw new UserFacingError(`${waiting} unit${waiting === 1 ? " is" : "s are"} still waiting to be sourced for this order. Record the received goods (Admin → Inventory) before shipping it.`);
      }
    }

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: existing.status },
      data: { status },
    });
    if (claimed.count !== 1) {
      throw new UserFacingError(
        "This order was just changed by someone else. Refresh and try again.",
      );
    }

    if (shouldReleaseStock(existing.status, status)) {
      // Goods that never left are returned automatically; goods that shipped come back only through a RESTOCK incident (sellable) or a DISCARD.
      await restoreOrderStock(tx, orderId, releaseModeFor(existing.status));
    }

    // Delivery rewards: earned when the order is DELIVERED (idempotent); withdrawn if that order is later refunded/returned;
    // given back if the order that REDEEMED one is cancelled/failed before it was ever delivered.
    if (status === "DELIVERED") {
      await issueRewardForDeliveredOrder(tx, orderId);
      await recordCodCollection(tx, orderId); // the COD balance is collected now: an explicit record, so the payment status is derived
    }
    if (status === "REFUNDED") await revokeRewardEarnedBy(tx, orderId);
    if ((status === "CANCELLED" || status === "FAILED_DELIVERY") && existing.status !== "DELIVERED") await releaseRewardUsedBy(tx, orderId);

    // Reviews of this order's items stop/resume counting when it leaves/returns to DELIVERED
    // (visibility is derived at read time; this records why, in the moderation history).
    await recordEligibilityChange(tx, orderId, existing.status, status);

    await tx.orderTrackingEvent.create({
      data: {
        orderId,
        status,
        note: note?.trim() ? note.trim().slice(0, 500) : undefined,
      },
    });
    // In-app notification for the customer (deduplicated per order + status).
    const message = orderStatusNotification(status, existing.orderNumber);
    if (message) {
      await notifyUser(tx, { userId: existing.userId, type: message.type, title: message.title, body: message.body, href: message.href, dedupeKey: message.dedupeKey(orderId) });
    }
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

