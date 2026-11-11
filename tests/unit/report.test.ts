import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalesReport, csvCell, ordersCsv, parseReportRange, toCsv, topProductsCsv, type ReportOrder } from "@/lib/report";

const order = (o: Partial<ReportOrder> & { items?: ReportOrder["items"] } = {}): ReportOrder => ({
  orderNumber: "AP-1", createdAt: new Date("2026-10-10T08:30:00Z"), status: "DELIVERED", paymentStatus: "PAID",
  subtotal: 1000, discountTotal: 100, shippingTotal: 70, taxTotal: 0, total: 970, email: "a@b.co", phone: "01711000000",
  deliveryZone: "DHAKA_CITY", courierName: "Steadfast", trackingNumber: "T1", shippingSnapshot: { fullName: "Buyer One" },
  items: [{ productId: "p1", productName: "Vase", quantity: 2, lineTotal: 1000 }], ...o,
});

test("date range: defaults, swapping, validation, cap, inclusive end (store time)", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  const d = parseReportRange(undefined, undefined, now);
  assert.deepEqual([d.from, d.to, d.days, d.adjusted], ["2026-09-11", "2026-10-10", 30, false]);
  const r = parseReportRange("2026-10-01", "2026-10-10", now);
  assert.equal(r.start.toISOString(), "2026-09-30T18:00:00.000Z");
  assert.equal(r.end.toISOString(), "2026-10-10T17:59:59.999Z");
  assert.equal(r.days, 10);
  assert.deepEqual([parseReportRange("2026-10-10", "2026-10-01", now).from, parseReportRange("2026-10-10", "2026-10-01", now).to], ["2026-10-01", "2026-10-10"]);
  assert.equal(parseReportRange("junk", "2026-10-01", now).adjusted, true);
  assert.equal(parseReportRange("2026-02-30", "2026-03-01", now).from, "2026-09-11"); // impossible date → default
  const huge = parseReportRange("2020-01-01", "2026-10-10", now);
  assert.equal(huge.days, 366);
  assert.equal(huge.adjusted, true);
  assert.equal(huge.to, "2026-10-10");
  // late-evening Dhaka orders belong to that Dhaka day
  const late = parseReportRange("2026-10-10", "2026-10-10", now);
  assert.ok(new Date("2026-10-10T17:00:00Z") <= late.end && new Date("2026-10-10T18:00:00Z") > late.end);
});

test("report: sales exclude cancelled/refunded/failed; delivered split; averages; status counts", () => {
  const r = buildSalesReport([
    order({ orderNumber: "A", status: "DELIVERED" }),
    order({ orderNumber: "B", status: "PENDING", total: "530.50", subtotal: "500.50", discountTotal: 0, shippingTotal: 30, items: [{ productId: "p2", productName: "Mug", quantity: 3, lineTotal: "500.50" }] }),
    order({ orderNumber: "C", status: "CANCELLED" }),
    order({ orderNumber: "D", status: "REFUNDED" }),
    order({ orderNumber: "E", status: "FAILED_DELIVERY" }),
  ]);
  assert.equal(r.orderCount, 5);
  assert.equal(r.salesCount, 2);
  assert.equal(r.notCountedCount, 3);
  assert.equal(r.netRevenue, 1500.5);
  assert.equal(r.grossSales, 1500.5);
  assert.equal(r.discounts, 100);
  assert.equal(r.shipping, 100);
  assert.equal(r.deliveredCount, 1);
  assert.equal(r.deliveredRevenue, 970);
  assert.equal(r.averageOrderValue, 750.25);
  assert.deepEqual(r.byStatus, { DELIVERED: 1, PENDING: 1, CANCELLED: 1, REFUNDED: 1, FAILED_DELIVERY: 1 });
  assert.equal(buildSalesReport([]).averageOrderValue, 0);
});

test("top products: only counted orders, summed per product, ordered by units then revenue, limited", () => {
  const items = (id: string, qty: number, total: number) => [{ productId: id, productName: id.toUpperCase(), quantity: qty, lineTotal: total }];
  const r = buildSalesReport([
    order({ items: items("a", 2, 200) }), order({ items: items("a", 1, 100) }), order({ items: items("b", 3, 300) }),
    order({ items: items("c", 3, 450) }), order({ status: "CANCELLED", items: items("z", 99, 9999) }),
  ], 3);
  assert.deepEqual(r.topProducts.map((p) => [p.productId, p.quantity, p.revenue]), [["c", 3, 450], ["a", 3, 300], ["b", 3, 300]]); // c wins on revenue; a/b tie → name order
  assert.ok(!r.topProducts.some((p) => p.productId === "z"));
  assert.equal(buildSalesReport([order()], 0).topProducts.length, 0);
});

test("CSV: quoting and formula-injection protection", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  for (const evil of ["=HYPERLINK(\"http://evil\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
    const cell = csvCell(evil);
    assert.ok(cell.replace(/^"/, "").startsWith("'"), `${JSON.stringify(evil)} -> ${cell}`);
  }
  assert.equal(csvCell(-5), "-5"); // real numbers stay numbers
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(NaN), "");
  assert.equal(csvCell(new Date("2026-01-01T00:00:00Z")), "2026-01-01T00:00:00.000Z");
});

test("orders CSV: header, BOM, CRLF, Dhaka time, neutralized hostile customer name", () => {
  const csv = ordersCsv([order({ shippingSnapshot: { fullName: '=cmd|"/c calc"!A0' }, orderNumber: "AP-9" })]);
  assert.ok(csv.startsWith("\uFEFFOrder number,Placed (Dhaka time),Status"));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("AP-9,2026-10-10 14:30,DELIVERED,PAID,"));
  assert.ok(lines[1].includes("\"'=cmd|\"\"/c calc\"\"!A0\""));
  assert.ok(!/,=cmd/.test(lines[1]));
  assert.equal(toCsv(["a"], []), "\uFEFFa\r\n");
  assert.equal(topProductsCsv(buildSalesReport([order()])).split("\r\n")[1], "Vase,2,1000");
});
