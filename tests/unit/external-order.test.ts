import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExternalTotals, normalizeExternalRef, parseExternalOrderInput } from "@/lib/external-order";
import { aggregateChannelReport, type ReportChannel, type ReportOrderRow } from "@/lib/channel-report";

const good = () => ({
  channelId: "channel_daraz", externalOrderRef: " d-1001 ",
  customer: { fullName: "Jo Doe", phone: "+880 1711-000000", line1: "House 1, Road 2", email: "" },
  items: [{ productId: "p1", quantity: 2, unitPrice: 450.5, unitCost: 300 }, { productId: "p2", variantId: "v1", quantity: 1, unitPrice: 100 }],
  shippingTotal: 60, discountTotal: 50,
});

test("external references normalise so duplicates cannot hide behind spacing/case/dash style", () => {
  for (const same of ["D-1001", " d-1001 ", "d - 1001", "D\u20131001", "d\u20141001"]) assert.deepEqual(normalizeExternalRef(same), { ok: true, value: "D-1001" });
  for (const bad of ["", "ab", "x".repeat(81), "D<1001>", "D 1001; DROP", 5, null, undefined]) assert.equal(normalizeExternalRef(bad as never).ok, false, String(bad));
});

test("valid manual order: parsed, phone/ref normalised, totals computed from entered prices", () => {
  const r = parseExternalOrderInput(good());
  assert.ok(r.ok);
  assert.equal(r.value.externalOrderRef, "D-1001");
  assert.equal(r.value.customer.phone, "+8801711000000");
  assert.equal(r.value.status, "CONFIRMED");
  assert.equal(r.value.stockPolicy, "DEDUCT");
  assert.equal(r.value.paymentStatus, "PAID");
  assert.deepEqual(computeExternalTotals(r.value.items, r.value.shippingTotal, r.value.discountTotal), { subtotal: 1001, total: 1011 });
});

test("invalid manual orders are rejected with a clear message", () => {
  const bad = (mut: (o: ReturnType<typeof good>) => unknown, re: RegExp) => {
    const o = good(); const r = parseExternalOrderInput(mut(o) ?? o); assert.equal(r.ok, false); assert.match((r as { message: string }).message, re);
  };
  bad((o) => { o.items = []; }, /at least one item/);
  bad((o) => { o.items[0].quantity = 0; }, /./);
  bad((o) => { o.items[0].quantity = 1.5; }, /whole number/);
  bad((o) => { o.items[0].unitPrice = -1; }, /negative/);
  bad((o) => { o.items[0].unitPrice = 10.123; }, /2 decimal/);
  bad((o) => { o.items[0].unitPrice = NaN; }, /./);
  bad((o) => { o.customer.phone = "abc"; }, /phone/);
  bad((o) => { o.customer.fullName = " "; }, /name/);
  bad((o) => { o.customer.email = "nope"; }, /email/);
  bad((o) => { o.externalOrderRef = "x"; }, /3–80/);
  bad((o) => { o.discountTotal = 5000; }, /discount/i);
  bad((o) => ({ ...o, status: "REFUNDED" }), /./);                       // cannot be created as a terminal state
  bad((o) => ({ ...o, externalPlacedAt: "not a date" }), /date/);
  bad((o) => ({ ...o, externalPlacedAt: new Date(Date.now() + 5 * 86400000).toISOString() }), /future/);
  bad((o) => ({ ...o, costLines: [{ kind: "BRIBE", amount: 5 }] }), /./);
  bad((o) => ({ ...o, costLines: [{ kind: "OTHER", amount: -5 }] }), /negative/);
  assert.equal(parseExternalOrderInput(null).ok, false);
  assert.equal(parseExternalOrderInput("x").ok, false);
});

const channels: ReportChannel[] = [
  { id: "w", name: "Website", kind: "WEBSITE" }, { id: "d", name: "Daraz", kind: "MARKETPLACE" }, { id: "c", name: "Cartup", kind: "MARKETPLACE" },
];
const order = (o: Partial<ReportOrderRow>): ReportOrderRow => ({
  channelId: "w", status: "DELIVERED", paymentStatus: "PAID", subtotal: 1000, discountTotal: 0, shippingTotal: 100, total: 1100,
  items: [{ quantity: 2, lineTotal: 1000, unitCost: 300 }], costLines: [], ...o,
});

test("report: revenue, costs, courier fees, expenses and profit ESTIMATE are separate values", () => {
  const { channels: out, combined } = aggregateChannelReport(
    [
      order({}),
      order({ costLines: [{ kind: "COURIER_FEE", amount: 120 }] }),
      order({ channelId: "d", total: 2000, subtotal: 2000, shippingTotal: 0, items: [{ quantity: 4, lineTotal: 2000, unitCost: 250 }], costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 200 }, { kind: "PACKAGING", amount: 30 }] }),
    ],
    [{ amount: 500, channelId: "d" }, { amount: 100, channelId: null }],
    channels,
  );
  const web = out[0], daraz = out[1];
  assert.deepEqual([web.orders, web.unitsSold, web.revenue, web.productCost, web.courierFees], [2, 4, 2200, 1200, 120]);
  assert.equal(web.profitEstimateBeforeExpenses, 2200 - 1200 - 120);
  assert.deepEqual([daraz.revenue, daraz.productCost, daraz.commissionRecorded, daraz.otherRecordedCosts, daraz.expenses], [2000, 1000, 200, 30, 500]);
  assert.equal(daraz.profitEstimateBeforeExpenses, 2000 - 1000 - 200 - 30);
  assert.equal(daraz.netProfitEstimate, 770 - 500);
  assert.equal(out[2].orders, 0);
  // website + marketplaces SUM to combined; unassigned expenses only appear in combined
  assert.equal(combined.revenue, web.revenue + daraz.revenue + out[2].revenue);
  assert.equal(combined.expenses, 600);
  assert.equal(combined.netProfitEstimate, combined.profitEstimateBeforeExpenses - 600);
  assert.equal(combined.orders, 3);
});

test("report: cancelled/refunded/failed are counted separately and never in revenue", () => {
  const { combined } = aggregateChannelReport([order({}), order({ status: "CANCELLED" }), order({ status: "REFUNDED" }), order({ status: "FAILED_DELIVERY" })], [], channels);
  assert.deepEqual([combined.orders, combined.cancelledOrReturned, combined.revenue], [1, 3, 1100]);
});

test("report: unknown cost is NOT treated as zero — coverage shows how much is known; no invented commission", () => {
  const { channels: out } = aggregateChannelReport(
    [order({ channelId: "d", items: [{ quantity: 1, lineTotal: 500, unitCost: null }, { quantity: 3, lineTotal: 500, unitCost: 100 }], total: 1000, costLines: [] })],
    [], channels,
  );
  const d = out[1];
  assert.equal(d.productCost, 300);
  assert.equal(d.costCoverage, 0.75);
  assert.equal(d.commissionRecorded, 0);
  assert.equal(d.ordersWithCommission, 0);                                // the UI reads this as "not recorded", not "0%"
});

test("report: money is summed exactly (no floating-point drift) and collected is VERIFIED money only (a PAID label is not cash)", () => {
  // Not delivered, no verified advance: nothing collected, whatever the payment-status label says.
  const rows = Array.from({ length: 1000 }, () => order({ total: 0.1, subtotal: 0.1, shippingTotal: 0, status: "PROCESSING", items: [{ quantity: 1, lineTotal: 0.1, unitCost: 0.2 }], paymentStatus: "PAID" }));
  const { combined } = aggregateChannelReport(rows, [], channels);
  assert.equal(combined.revenue, 100);
  assert.equal(combined.productCost, 200);
  assert.equal(combined.collected, 0);
  assert.equal(combined.profitEstimateBeforeExpenses, -100);              // a loss is shown as a loss
});

test("report: orders from channels outside the request are ignored", () => {
  const { combined } = aggregateChannelReport([order({ channelId: "zzz" })], [], channels);
  assert.equal(combined.orders, 0);
});
