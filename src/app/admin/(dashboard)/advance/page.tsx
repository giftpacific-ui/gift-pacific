import type { Metadata } from "next";
import { getAdvanceSettings } from "@/server/services/advance.service";
import { fraudCheckStatus } from "@/server/services/fraud-check.service";
import { AdvanceSettingsForm } from "@/features/admin/advance-settings-form";

export const metadata: Metadata = { title: "Advance payment · Admin" };

export default async function AdminAdvancePage() {
  const s = await getAdvanceSettings();
  const fc = fraudCheckStatus();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Advance payment &amp; trust policy</h1>
        <p className="text-sm text-muted-foreground">
          Orders to the chosen delivery zones need an advance before they can be confirmed. The advance is <strong>part of the order total</strong>; the rest is collected on delivery.
          The <strong>trust score</strong> (0–100 points; 100 = highest confidence in successful fulfilment) is a transparent rule-based heuristic computed only from the <strong>fraud-check</strong> record (courier-network delivered vs cancelled parcels) for the order&apos;s phone number. Fraud-check provider status: <strong>{!fc.enabled ? "switched off (FRAUD_CHECK_ENABLED=false)" : fc.configured ? `connected (${fc.provider})` : "unavailable (none configured)"}</strong> · timeout {fc.timeoutMs} ms · result cache {fc.cacheSeconds === 0 ? "off" : `${fc.cacheSeconds} s`} · up to {fc.maxCallsPerMinute} provider calls per minute · credentials {fc.credentialSource ? `from ${fc.credentialSource}` : fc.hasCredentials ? "set" : "not set"}. When it is unavailable, every customer gets the conservative default (50) and the standard advance. Delivered history is credited only for a <em>verified</em> phone; this project has no phone verification yet, so only cancelled parcels lower the score. The thresholds (60 / 80 / 100) are points on that scale, not probabilities. It is not a validated prediction or a fraud verdict. Each order stores the score, the reasons and the
          policy used, so past orders stay explainable after you change these settings.
        </p>
      </div>
      <AdvanceSettingsForm initial={{ ...s, instructions: s.instructions ?? "" }} />
    </div>
  );
}
