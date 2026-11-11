import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getAdminDashboardStats } from "@/server/services/admin-dashboard.service";
import { getAccounting } from "@/server/services/accounting.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" }); db.insert("salesChannel", { id: "channel_daraz", key: "daraz", name: "Daraz", kind: "MARKETPLACE" }); });

const order = (id: string, o: Record<string, unknown>) =>
  db.insert("order", { id, orderNumber: `AP-${id}`, phone: "0", paymentStatus: "PAID", status: "DELIVERED", channelId: "channel_website", total: 1000, createdAt: new Date(), ...o });

test("dashboard chart and finance cards use the SAME orders and rule as the Accounts page: sale orders of every channel; cancelled/refunded/failed excluded", async () => {
  order("a", { total: 1000 });
  order("b", { total: 500, status: "SHIPPED" });
  order("c", { total: 7000, status: "CANCELLED" });
  order("d", { total: 3000, status: "REFUNDED" });
  order("e", { total: 900, status: "FAILED_DELIVERY" });
  order("f", { total: 5000, channelId: "channel_daraz" });                 // marketplace sale: part of the business, so part of the dashboard
  order("g", { total: 400, paymentStatus: "UNPAID", status: "PENDING" });  // placed, not collected yet: still a sale (accrual)
  const stats = await runAs("admin", () => getAdminDashboardStats());
  const today = new Date().toISOString().slice(0, 7) + "-01";
  const accounts = await runAs("admin", () => getAccounting({ from: stats.financeRange.from, to: stats.financeRange.to }));
  assert.equal(stats.financeRange.from.slice(0, 7), today.slice(0, 7));
  assert.equal(stats.finance.orderValue, 1000 + 500 + 5000 + 400);
  assert.deepEqual(stats.finance, accounts.summary);                         // identical to the Accounts page, field for field
  const chartTotal = stats.revenueByDay.reduce((s, d) => s + d.total, 0);
  assert.equal(chartTotal, stats.finance.orderValue);                        // the chart can never disagree with the card
  assert.equal(stats.totalOrders, 6);                                        // website orders only (a count, not money)
  assert.equal(stats.pendingOrders, 1);
});
