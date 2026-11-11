import type { Metadata } from "next";
import { prisma } from "@/lib/db/prisma";
import { getBkashConfig } from "@/lib/payments/bkash";
import { getCourierProviderStatuses } from "@/lib/courier/registry";
import { absoluteUrl } from "@/lib/seo";
import { TestConnectionButton } from "@/features/admin/gateway-transaction-actions";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Integrations · Admin" };
export const dynamic = "force-dynamic";

/**
 * Status only. Credentials live in the server environment (see .env.example); this page shows WHETHER each value is set
 * and which variable names are missing, never a value, so no secret reaches the page props or the browser.
 */
export default async function IntegrationsPage() {
  const bkash = getBkashConfig();
  const couriers = getCourierProviderStatuses(process.env);
  const [lastOk, lastFail] = await Promise.all([
    prisma.gatewayTransaction.findFirst({ where: { provider: "BKASH", status: "SUCCEEDED" }, orderBy: { verifiedAt: "desc" }, select: { verifiedAt: true } }),
    prisma.gatewayTransaction.findFirst({ where: { provider: "BKASH", status: { in: ["FAILED", "NEEDS_REVIEW"] } }, orderBy: { updatedAt: "desc" }, select: { failureReason: true, updatedAt: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Integrations</h1>
        <p className="text-sm text-muted-foreground">Connection status for payment and courier providers. Secrets are set in the server environment and are never shown here.</p>
      </div>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg">bKash (online payment)</h2>
          <Badge variant={bkash.problem ? "secondary" : "default"}>{bkash.problem ? "Not active" : `Active · ${bkash.environment.toLowerCase()}`}</Badge>
        </div>
        {bkash.problem && <p className="text-sm text-muted-foreground">{bkash.problem}</p>}
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Mode</dt><dd>{bkash.environment === "PRODUCTION" ? "Production (live money)" : "Sandbox (test)"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Callback URL to register with bKash</dt><dd className="break-all font-mono text-xs">{absoluteUrl("/api/payments/bkash/callback")}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last confirmed payment</dt><dd>{lastOk?.verifiedAt ? formatDate(lastOk.verifiedAt) : "None yet"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last problem</dt><dd>{lastFail ? `${lastFail.failureReason ?? "Failed"} (${formatDate(lastFail.updatedAt)})` : "None"}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">Environment variables: BKASH_ENABLED, BKASH_ENV, BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD (optional: BKASH_BASE_URL, BKASH_TIMEOUT_MS).</p>
        {bkash.missing.length === 0 ? <TestConnectionButton /> : <p className="text-xs text-amber-700">Still empty: {bkash.missing.join(", ")}</p>}
        <p className="text-xs text-muted-foreground">The integration follows the bKash Tokenized Checkout contract as published by open-source clients; it has not been run against a bKash account. Run one sandbox payment before switching BKASH_ENV to production.</p>
      </section>

      {couriers.map((c) => (
        <section key={c.key} className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg">{c.label} (courier)</h2>
            <Badge variant={c.usable ? "default" : "secondary"}>{c.usable ? "Active" : c.adapterAvailable ? "Not active" : "Not available"}</Badge>
          </div>
          {c.problem && <p className="text-sm text-muted-foreground">{c.problem}</p>}
          {c.adapterAvailable && (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">Webhook URL to give the courier</dt><dd className="break-all font-mono text-xs">{absoluteUrl(`/api/courier/webhook/${c.key}`)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Webhook secret</dt><dd>{c.hasWebhookSecret ? "Set" : "Not set"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">API base URL</dt><dd>{c.customBaseUrl ? "Custom (set)" : "Provider default"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Pickup store selection</dt><dd>{c.capabilities.pickupStores ? "Available" : "Not available for this courier here"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Cancel a booking</dt><dd>{c.capabilities.cancel ? "Available" : "Not available for this courier here"}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">
                Environment variables: {c.envPrefix}_ENABLED, {c.envPrefix}_API_KEY, {c.envPrefix}_API_SECRET, {c.envPrefix}_WEBHOOK_SECRET (optional: {c.envPrefix}_API_BASE_URL, {c.envPrefix}_TIMEOUT_MS, {c.envPrefix}_TRACKING_URL_TEMPLATE). The older COURIER_* names keep working for the courier named by COURIER_PROVIDER.
              </p>
            </>
          )}
        </section>
      ))}

      <p className="text-xs text-muted-foreground">
        Default courier: COURIER_DEFAULT_PROVIDER, else COURIER_PROVIDER, else the first configured courier. The original webhook URL /api/courier/webhook keeps serving the default courier.
      </p>

      <section className="space-y-2 rounded-xl border border-border/70 bg-card p-4 text-sm">
        <h2 className="font-heading text-lg">Not available</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li><span className="font-medium text-foreground">Nagad:</span> its integration contract (encrypted payloads and signatures) is only issued to onboarded merchants and has not been provided, so nothing is implemented.</li>
        </ul>
      </section>
    </div>
  );
}
