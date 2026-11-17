import type { Metadata } from "next";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { StoreSettingsForm } from "@/features/admin/store-settings-form";
import { serializeDecimals } from "@/lib/serialize";
import { siteConfig } from "@/config/site";
import { getTrackingDiagnostics } from "@/server/services/tracking-diagnostics.service";
import { TrackingDiagnosticsPanel } from "@/features/admin/tracking-diagnostics-panel";

export const metadata: Metadata = { title: "Store Settings · Admin" };

export default async function AdminSettingsPage() {
  const settings = await getStoreSettings();
  const diagnostics = await getTrackingDiagnostics();

  return (
    <div className="space-y-6 mx-auto w-full max-w-7xl">
      <h1 className="font-heading text-2xl font-semibold">Store settings</h1>
      <StoreSettingsForm settings={serializeDecimals(settings)} />

      <TrackingDiagnosticsPanel data={diagnostics} />

      <div className="rounded-2xl border border-border/70 bg-card p-6">
        <h3 className="font-heading text-lg font-semibold">
          System information
        </h3>
        <dl className="mt-3 space-y-1 text-sm text-muted-foreground">
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Current Version:</dt>
            <dd>{siteConfig.version}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Release:</dt>
            <dd>{siteConfig.release}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
