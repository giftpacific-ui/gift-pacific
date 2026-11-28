/**
 * Customer history statistics (pure). Computed from the customer's real website orders; nothing is estimated.
 *
 * Definitions (shown to admins verbatim, so the numbers can be checked):
 *  - total: every website order matched to the customer (same normalised phone, e-mail, or account).
 *  - confirmed / delivered / failed delivery: orders that EVER reached that stage (from the order's recorded status history), so a parcel that failed once
 *    and was delivered on the second attempt counts in both.
 *  - cancelled: orders whose current status is CANCELLED.
 *  - cancellation rate = cancelled / total.   failed-delivery rate = failed / (delivered + failed), i.e. of the parcels that reached an outcome.
 *  - successful purchase value: sum of totals of orders currently DELIVERED (refunded orders are not counted).
 *  - refused COD: NOT RECORDED by the system (there is no field for it); the nearest recorded outcome is a failed delivery.
 */
export type StatOrder = {
  status: string; total: number; riskLevel: string | null; riskReviewDecision: string | null; riskReviewedLevel: string | null;
  events: string[]; // statuses of the order's tracking history
};

export type CustomerStats = {
  total: number; confirmed: number; delivered: number; cancelled: number; failedDelivery: number;
  fraudRejected: number; highRisk: number; criticalRisk: number; overriddenApprovals: number;
  successfulValue: number;
  cancellationRate: number | null; failedDeliveryRate: number | null;
  refusedCod: null;
};

const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

export function computeCustomerStats(orders: StatOrder[]): CustomerStats {
  const ever = (o: StatOrder, s: string) => o.events.includes(s);
  const total = orders.length;
  const delivered = orders.filter((o) => ever(o, "DELIVERED")).length;
  const failedDelivery = orders.filter((o) => ever(o, "FAILED_DELIVERY")).length;
  const cancelled = orders.filter((o) => o.status === "CANCELLED").length;
  return {
    total,
    confirmed: orders.filter((o) => ever(o, "CONFIRMED")).length,
    delivered,
    cancelled,
    failedDelivery,
    fraudRejected: orders.filter((o) => o.riskReviewDecision === "REJECTED").length,
    highRisk: orders.filter((o) => o.riskLevel === "HIGH").length,
    criticalRisk: orders.filter((o) => o.riskLevel === "CRITICAL").length,
    overriddenApprovals: orders.filter((o) => o.riskReviewDecision === "APPROVED" && (o.riskReviewedLevel === "HIGH" || o.riskReviewedLevel === "CRITICAL")).length,
    successfulValue: Math.round(orders.filter((o) => o.status === "DELIVERED").reduce((n, o) => n + o.total, 0) * 100) / 100,
    cancellationRate: ratio(cancelled, total),
    failedDeliveryRate: ratio(failedDelivery, delivered + failedDelivery),
    refusedCod: null,
  };
}

/** 01711000000 -> 0171****000. Reports show masked numbers; the order links give admins the detail. */
export function maskPhone(p: string | null | undefined): string {
  if (!p || p === "-") return "unknown";
  return p.length >= 8 ? `${p.slice(0, 4)}****${p.slice(-3)}` : "****";
}
export function maskEmail(e: string | null | undefined): string {
  if (!e) return "unknown";
  const at = e.indexOf("@");
  return at < 1 ? "****" : `${e[0]}***${e.slice(at)}`;
}
