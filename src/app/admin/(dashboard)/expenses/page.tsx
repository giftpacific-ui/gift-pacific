import type { Metadata } from "next";
import { adminListChannels, adminListExpenses } from "@/server/services/external-order.service";
import { parseReportRange } from "@/lib/report";
import { ExpensesManager } from "@/features/admin/expenses-manager";

export const metadata: Metadata = { title: "Expenses · Admin" };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const range = parseReportRange(sp.from, sp.to);
  const [expenses, channels] = await Promise.all([adminListExpenses(range.from, range.to), adminListChannels()]);
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Expenses</h1>
        <p className="text-sm text-muted-foreground">Business costs not tied to one order (advertising, tools, rent). They appear in the channel report as a separate line, never mixed into revenue.</p>
      </div>
      <form className="flex flex-wrap items-end gap-2" aria-label="Period">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<input type="date" name="from" defaultValue={range.from} className="h-10 rounded-md border border-input bg-background px-3 text-sm" /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<input type="date" name="to" defaultValue={range.to} className="h-10 rounded-md border border-input bg-background px-3 text-sm" /></label>
        <button className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:border-foreground">Show</button>
      </form>
      <ExpensesManager expenses={expenses} channels={channels.map((c) => ({ id: c.id, name: c.name }))} today={range.to} />
    </div>
  );
}
