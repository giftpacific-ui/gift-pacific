/** Validation for loss/return/refund incidents (pure, tested). Returns an error message or null. */
export const INCIDENT_KINDS = ["DAMAGED_BEFORE_DISPATCH", "DAMAGED_IN_PACKAGING", "DAMAGED_BOX", "DAMAGED_IN_TRANSIT", "CUSTOMER_RETURN", "FAILED_DELIVERY", "REFUND", "COURIER_RETURN_FEE", "UNSELLABLE_WRITE_OFF", "OTHER"] as const;
export type IncidentKindName = (typeof INCIDENT_KINDS)[number];
export type StockEffectName = "NONE" | "RESTOCK" | "WRITE_OFF" | "DISCARD";

export type IncidentInput = {
  kind: IncidentKindName;
  occurredOn: string; // YYYY-MM-DD
  quantity: number;
  stockEffect: StockEffectName;
  lossAmount: number;
  refundAmount: number;
  courierFee: number;
  hasOrderItem: boolean;
  hasProduct: boolean;
};

const RESTOCK_KINDS: readonly string[] = ["CUSTOMER_RETURN", "FAILED_DELIVERY"];
/** Goods that already left with an order and came back (or stay) unsellable. */
const DISCARD_KINDS: readonly string[] = ["CUSTOMER_RETURN", "FAILED_DELIVERY", "DAMAGED_IN_TRANSIT"];
const NO_WRITE_OFF_KINDS: readonly string[] = ["REFUND", "COURIER_RETURN_FEE"];
const money = (n: number) => Number.isFinite(n) && n >= 0 && n <= 10_000_000 && Math.round(n * 100) / 100 === n;

export function validateIncident(i: IncidentInput, now = new Date()): string | null {
  if (!(INCIDENT_KINDS as readonly string[]).includes(i.kind)) return "Choose what happened.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.occurredOn) || Number.isNaN(Date.parse(i.occurredOn))) return "Enter a valid date.";
  if (Date.parse(i.occurredOn) > now.getTime() + 24 * 3600 * 1000) return "The date cannot be in the future.";
  if (![i.lossAmount, i.refundAmount, i.courierFee].every(money)) return "Amounts must be 0 or more, with at most 2 decimal places.";
  if (!Number.isInteger(i.quantity) || i.quantity < 0 || i.quantity > 99_999) return "Quantity must be a whole number.";
  if (i.stockEffect !== "NONE") {
    if (i.quantity < 1) return "Enter how many units are affected.";
    if (!i.hasProduct) return "Choose the product.";
  }
  if (i.stockEffect === "RESTOCK") {
    if (!RESTOCK_KINDS.includes(i.kind)) return "Only returned or undelivered goods can be put back into stock.";
    if (!i.hasOrderItem) return "Restocking must be tied to the order line it came from (use a stock adjustment for anything else).";
    if (i.lossAmount > 0) return "Goods put back into stock are not a loss: set the loss to 0 (record damaged units separately).";
  }
  if (i.stockEffect === "DISCARD") {
    if (!DISCARD_KINDS.includes(i.kind)) return "Only returned, undelivered or transit-damaged goods can be marked unsellable.";
    if (!i.hasOrderItem) return "Unsellable returned goods must be tied to the order line they came from.";
  }
  if (i.stockEffect === "WRITE_OFF") {
    if (NO_WRITE_OFF_KINDS.includes(i.kind)) return "This kind of record cannot remove stock.";
    // Units of an order line already left sellable stock when the order was placed: removing them again would count them out twice.
    if (i.hasOrderItem) return "Units of an order line already left stock when the order was placed. For returned goods that cannot be resold choose \"Unsellable (stay out of stock)\"; use a write-off only for units that are on your shelf.";
  }
  if (i.kind === "REFUND" && i.refundAmount <= 0) return "Enter the refunded amount.";
  if (i.kind === "COURIER_RETURN_FEE" && i.courierFee <= 0) return "Enter the courier fee.";
  if (i.kind.startsWith("DAMAGED") && i.lossAmount <= 0) return "Enter the cost of what was damaged.";
  if (i.stockEffect === "NONE" && i.lossAmount + i.refundAmount + i.courierFee <= 0) return "This record has no financial or stock effect.";
  return null;
}
