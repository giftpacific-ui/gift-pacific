import "server-only";
import { prisma } from "@/lib/db/prisma";
import { aggregateChannelReport, type ReportChannel } from "@/lib/channel-report";
import { loadAccountingInputs } from "@/server/services/accounting.service";

/**
 * Channel report for a Dhaka-day range, built from the SAME loader and definitions as the Accounts page
 * (external orders dated by the marketplace's placed date, website orders by creation). Filters narrow the scope.
 */
export async function getChannelReport(params: { from?: string; to?: string; channelId?: string; status?: string }) {
  const allChannels = await prisma.salesChannel.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] });
  const channels: ReportChannel[] = allChannels.filter((c) => !params.channelId || c.id === params.channelId).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  const inputs = await loadAccountingInputs(params);
  const agg = aggregateChannelReport(
    inputs.orders.map((o) => ({ ...o, channelId: o.channelId ?? "" })),
    inputs.expenses.map((e) => ({ amount: e.amount, channelId: e.channelId ?? null })),
    channels,
    inputs.incidents,
  );
  return { range: inputs.range, truncated: inputs.truncated, ...agg };
}
