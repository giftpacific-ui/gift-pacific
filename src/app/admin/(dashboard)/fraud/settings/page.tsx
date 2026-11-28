import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/current-user";
import { getFraudPolicy, listActiveAdmins } from "@/server/services/fraud-risk.service";
import { FraudNav } from "@/features/admin/fraud-nav";
import { FraudPolicyForm } from "@/features/admin/fraud-policy-form";

export const metadata: Metadata = { title: "Fraud settings · Admin" };

export default async function AdminFraudSettingsPage() {
  await requireAdmin();
  const [{ policy, problem }, admins] = await Promise.all([getFraudPolicy(), listActiveAdmins()]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Fraud settings</h1>
        <p className="text-sm text-muted-foreground">
          The score is the sum of explained signals, each backed by real order, payment or list records. It never replaces your judgement, never marks an advance as verified and never bypasses the low-trust review.
          Each order keeps the policy it was scored with, so changing these settings does not rewrite why an earlier order scored as it did.
        </p>
      </div>
      <FraudNav active="/admin/fraud/settings" />
      <p className="rounded-md bg-muted p-3 text-sm">
        Retention job (erases old IP addresses and prepares legacy orders for matching):{" "}
        {(process.env.CRON_SECRET?.trim().length ?? 0) >= 24
          ? "enabled. Schedule POST /api/fraud/maintenance with the bearer secret (daily is enough)."
          : "disabled: CRON_SECRET is missing or too short. You can still run it by hand below, but IP addresses are only erased when it runs."}
      </p>
      <FraudPolicyForm initial={policy} admins={admins} problem={problem} />
    </div>
  );
}
