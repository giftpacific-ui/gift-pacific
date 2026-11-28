import type { Metadata } from "next";
import Link from "next/link";
import { getAdvanceSettings } from "@/server/services/advance.service";
import { getIntelligenceProviderStatuses, intelligenceSettings } from "@/server/services/courier-intelligence.service";
import { AdvanceSettingsForm } from "@/features/admin/advance-settings-form";

export const metadata: Metadata = { title: "Advance payment · Admin" };

const STATE_TEXT: Record<string, string> = {
  connected: "connected (a real lookup succeeded)",
  configured_unverified: "configured, not yet verified by a real lookup",
  error: "last lookup failed",
  not_configured: "not configured",
  unsupported: "no history lookup offered",
};

export default async function AdminAdvancePage() {
  const s = await getAdvanceSettings();
  const fc = intelligenceSettings();
  const providers = await getIntelligenceProviderStatuses();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Advance payment &amp; trust policy</h1>
        <p className="text-sm text-muted-foreground">
          Orders to the chosen delivery zones need an advance before they can be confirmed. The advance is <strong>part of the order total</strong>; the rest is collected on delivery.
          The decision uses the customer&apos;s <strong>courier delivery success rate</strong>: delivered ÷ (delivered + cancelled) parcels reported by the couriers for the order&apos;s phone number, shown as a percentage.
          There is no default score: with no history, too few parcels, too few couriers, an outage or an invalid phone, the number is <strong>unrated</strong> and gets the standard advance plus a review (when enabled). An outage never lowers an advance.
          Our own website order history is never used. The thresholds (60 / 80 / 100) are percentages of that rate, not probabilities. A good record lowers the advance only if you enable it below, and only for a verified phone unless you explicitly accept unverified ones.
          It is a transparent rule, not a validated prediction or a fraud verdict. Each order stores the rate, the evidence and the policy used, so past orders stay explainable after you change these settings.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Lookups: {fc.enabled ? "on" : "switched off (FRAUD_CHECK_ENABLED=false or FRAUD_CHECK_PROVIDER=none)"} · timeout {fc.timeoutMs} ms · result cache {fc.cacheSeconds === 0 ? "off" : `${fc.cacheSeconds} s`} · up to {fc.maxCallsPerMinute} calls per minute per courier.{" "}
          {providers.map((p) => `${p.label}: ${STATE_TEXT[p.state]}`).join(" · ")}.{" "}
          <Link href="/admin/fraud-check" className="text-primary underline">Courier Fraud Check</Link> shows the full per-courier status.
        </p>
      </div>
      <AdvanceSettingsForm initial={{ ...s, instructions: s.instructions ?? "" }} />
    </div>
  );
}
