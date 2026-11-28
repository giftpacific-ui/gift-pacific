import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/current-user";
import { listRiskEntries } from "@/server/services/risk-list.service";
import { FraudNav } from "@/features/admin/fraud-nav";
import { RiskListManager } from "@/features/admin/risk-list-manager";

export const metadata: Metadata = { title: "Block & allow lists · Admin" };

export default async function AdminRiskListsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const entries = await listRiskEntries({ includeInactive: sp.all === "1", search: sp.q });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Block &amp; allow lists</h1>
        <p className="text-sm text-muted-foreground">
          Entries are never deleted and every change is in the audit log. Nothing is added automatically: only an admin can block, with a reason. A blocked phone or e-mail holds the order for manual review
          (or refuses it, if you chose that in Settings); an IP block only sends the order for review.{" "}
          <a className="underline" href={sp.all === "1" ? "/admin/fraud/lists" : "/admin/fraud/lists?all=1"}>{sp.all === "1" ? "Hide disabled and expired" : "Show disabled and expired"}</a>
        </p>
      </div>
      <FraudNav active="/admin/fraud/lists" />
      <RiskListManager entries={entries} />
    </div>
  );
}
