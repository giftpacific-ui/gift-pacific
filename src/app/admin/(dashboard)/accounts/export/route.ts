import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth/current-user";
import { getAccounting } from "@/server/services/accounting.service";
import { ordersFinancialCsv, summaryToCsv } from "@/lib/accounting";

export const dynamic = "force-dynamic";

/** ?type=summary (default): the figures on the Accounts page. ?type=orders: one row per order from the same rules, with a TOTAL row that equals the summary. */
export async function GET(request: Request) {
  if (!(await getCurrentAdmin())) return new NextResponse("Forbidden", { status: 403 });
  const url = new URL(request.url);
  const type = url.searchParams.get("type") === "orders" ? "orders" : "summary";
  const { range, summary, orders } = await getAccounting({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined });
  const body = type === "orders" ? "\uFEFF" + ordersFinancialCsv(orders) : summaryToCsv(summary, range);
  return new NextResponse(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="accounts-${type}-${range.from}-to-${range.to}.csv"`, "Cache-Control": "no-store" },
  });
}
