import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getSalesReport } from "@/server/services/admin-report.service";
import { parseReportRange } from "@/lib/report";
import { GET } from "@/app/admin/(dashboard)/reports/export/route";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); });
const range = () => parseReportRange(undefined, undefined);

async function place(user: string, productId: string, qty: number) {
  await runAs({ sub: user }, () => addItemToCart({ productId, quantity: qty }));
  return runAs({ sub: user }, () => placeOrder(emptyCheckout));
}

test("report over real orders: counts, revenue, top products, cancelled orders excluded from sales", async () => {
  const a = await place("u1", "p-standard", 2); // 2 x 1800 + 70 delivery
  await place("u3", "p-bundle", 1); // 4500 + 70
  await adminUpdateOrderStatus(a.id, "CONFIRMED", undefined, TEST_ADMIN);
  const { report } = await getSalesReport(range());
  assert.equal(report.orderCount, 2);
  assert.equal(report.salesCount, 2);
  assert.equal(report.netRevenue, 3670 + 4570);
  assert.equal(report.topProducts.find((p) => p.name === "Clay Vase")!.quantity, 2);
  await adminUpdateOrderStatus(a.id, "CANCELLED", undefined, TEST_ADMIN);
  const after = (await getSalesReport(range())).report;
  assert.equal(after.salesCount, 1);
  assert.equal(after.netRevenue, 4570);
  assert.ok(!after.topProducts.some((p) => p.name === "Clay Vase"));
  assert.equal(after.byStatus.CANCELLED, 1);
});

test("orders outside the date range are excluded", async () => {
  const o = await place("u1", "p-standard", 1);
  db.tables.order.find((x) => x.id === o.id)!.createdAt = new Date("2020-01-01T00:00:00Z");
  assert.equal((await getSalesReport(range())).report.orderCount, 0);
  assert.equal((await getSalesReport(parseReportRange("2020-01-01", "2020-01-02"))).report.orderCount, 1);
});

test("CSV export route: admin only, correct headers, hostile names neutralized, never cached", async () => {
  const o = await place("u1", "p-standard", 1);
  db.tables.order.find((x) => x.id === o.id)!.shippingSnapshot = { fullName: "=1+1" };
  const req = (qs = "") => new Request(`http://localhost/admin/reports/export${qs}`);
  assert.equal((await runAs(null, () => GET(req()))).status, 401);
  assert.equal((await runAs({ sub: "customer" }, () => GET(req()))).status, 401);
  const res = await runAs("admin", () => GET(req("?type=orders")));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/csv/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-disposition")!, /^attachment; filename="orders-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv"$/);
  const text = await res.text();
  assert.ok(text.includes("'=1+1"));
  assert.ok(!text.includes(",=1+1"));
  const productsRes = await runAs("admin", () => GET(req("?type=products&from=junk")));
  const bytes = new Uint8Array(await productsRes.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel reads Bangla names
  const products = new TextDecoder().decode(bytes);
  assert.match(products, /^Product,Units sold,Revenue/);
  assert.ok(products.includes("Clay Vase,1,1800"));
});
