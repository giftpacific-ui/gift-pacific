import { getCurrentAdmin } from "@/lib/auth/current-user";
import { buildSalesReport, ordersCsv, parseReportRange, topProductsCsv } from "@/lib/report";
import { getReportOrders } from "@/server/services/admin-report.service";

// Admin-only CSV download. The session is verified here as well as by the
// admin proxy, so the export can never be reached without an admin login.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await getCurrentAdmin();
  if (!admin) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const range = parseReportRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const type = url.searchParams.get("type") === "products" ? "products" : "orders";

  const { orders } = await getReportOrders(range);
  const body = type === "products" ? topProductsCsv(buildSalesReport(orders, 1000)) : ordersCsv(orders);

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${type}-${range.from}_to_${range.to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
