/**
 * What a customer sees about money on an order. Derived ONLY from fields the order already carries
 * (advancePaid is verified advances only), so the page cannot disagree with the accounting rules.
 */
type PaymentRow = { id: string; method: string; kind: string; status: string; amount: unknown; verifiedAt: Date | null; createdAt: Date };

export function describeOrderPayment(order: {
  status: string;
  paymentStatus: string;
  total: unknown;
  advanceRequired: unknown;
  advancePaid: unknown;
  payments: PaymentRow[];
}) {
  const total = Number(order.total);
  const advancePaid = Number(order.advancePaid);
  const closed = ["CANCELLED", "REFUNDED", "FAILED_DELIVERY"].includes(order.status);
  const fullyPaid = order.paymentStatus === "PAID";
  const remainingDue = closed || fullyPaid ? 0 : Math.max(Math.round((total - advancePaid) * 100) / 100, 0);

  const rows = order.payments
    .filter((p) => p.kind !== "FULL" || p.status !== "UNPAID")
    .map((p) => ({
      id: p.id,
      label: p.kind === "ADVANCE" ? "Advance payment" : p.kind === "BALANCE" ? "Balance payment" : "Payment",
      method: p.method === "COD" ? "Cash on delivery" : p.method,
      amount: Number(p.amount),
      state:
        p.status === "PAID" ? ("verified" as const)
        : p.status === "PENDING" ? ("awaiting" as const)
        : p.status === "FAILED" ? ("rejected" as const)
        : p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED" ? ("refunded" as const)
        : ("awaiting" as const),
      at: p.verifiedAt ?? p.createdAt,
    }));

  return {
    advanceRequired: Number(order.advanceRequired),
    advancePaid,
    remainingDue,
    closed,
    fullyPaid,
    rows,
  };
}
