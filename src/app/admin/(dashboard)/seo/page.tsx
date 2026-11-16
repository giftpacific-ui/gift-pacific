import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getSeoOverview } from "@/server/services/admin-seo.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";

export const metadata: Metadata = { title: "SEO overview · Admin" };

const FILTER_LINK: Record<string, string> = { product: "/admin/seo/products", category: "/admin/seo/categories", box: "/admin/seo/boxes" };

function Stat({ label, value, href, warn }: { label: string; value: number; href?: string; warn?: boolean }) {
  const body = (
    <div className="rounded-lg border border-border/70 bg-background p-3">
      <p className={`text-2xl font-semibold ${warn && value > 0 ? "text-destructive" : ""}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
  return href ? <Link href={href} className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring">{body}</Link> : body;
}

export default async function SeoOverviewPage() {
  const origin = await getCanonicalOrigin();
  const [o, settings] = await Promise.all([getSeoOverview(origin), getStoreSettings()]);
  return (
    <div className="space-y-8">
      {settings.seoDefaultNoIndex && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          The whole site is set to <strong>noindex</strong> in <Link className="underline" href="/admin/seo/settings">Global settings</Link>. Search engines are asked not to list any page.
        </p>
      )}
      <p className="text-sm text-muted-foreground">Counts come straight from your data. &quot;No custom title&quot; is informational: those pages still get an automatic title from the record&apos;s own name. These are completeness checks, not a ranking score.</p>

      {o.entities.map((e) => (
        <section key={e.kind} className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between"><h2 className="font-heading text-lg">{e.label}</h2><Link className="text-sm underline underline-offset-4" href={FILTER_LINK[e.kind]}>Manage</Link></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Total" value={e.total} />
            <Stat label="No custom SEO title" value={e.noTitle} href={`${FILTER_LINK[e.kind]}?filter=missing-title`} />
            <Stat label="No meta description" value={e.noDescription} href={`${FILTER_LINK[e.kind]}?filter=missing-description`} />
            <Stat label="No OG image" value={e.noImage} href={`${FILTER_LINK[e.kind]}?filter=missing-image`} />
            <Stat label="Noindex" value={e.noindex} href={`${FILTER_LINK[e.kind]}?filter=noindex`} />
            <Stat label="Duplicate titles" value={e.duplicateTitles} warn />
          </div>
        </section>
      ))}

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
        <div className="flex items-center justify-between"><h2 className="font-heading text-lg">Built-in pages</h2><Link className="text-sm underline underline-offset-4" href="/admin/seo/pages">Manage</Link></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Pages" value={o.pages.total} /><Stat label="No custom title" value={o.pages.noTitle} /><Stat label="No description" value={o.pages.noDescription} /><Stat label="Noindex" value={o.pages.noIndex} /></div>
      </section>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
        <div className="flex items-center justify-between"><h2 className="font-heading text-lg">Static pages & redirects</h2><Link className="text-sm underline underline-offset-4" href="/admin/seo/static-pages">Manage</Link></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="CMS pages" value={o.cms.total} /><Stat label="Published" value={o.cms.published} /><Stat label="CMS noindex" value={o.cms.noindex} />
          <Stat label="CMS no description" value={o.cms.noDescription} /><Stat label="Active redirects" value={o.redirects.active} href="/admin/seo/redirects" /><Stat label="Inactive redirects" value={o.redirects.inactive} href="/admin/seo/redirects?status=inactive" />
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">Issues to review</h2>
        {o.invalidCanonicals.length === 0 && o.duplicates.length === 0 ? <p className="text-sm text-muted-foreground">No invalid canonical URLs or duplicate titles found.</p> : null}
        {o.invalidCanonicals.length > 0 && (
          <div><h3 className="mb-1 text-sm font-medium">Invalid canonical overrides</h3>
            <ul className="space-y-1 text-sm">{o.invalidCanonicals.map((c) => <li key={`${c.kind}-${c.name}`}><Badge variant="destructive">{c.kind}</Badge> {c.name} — <code className="text-xs">{c.value}</code></li>)}</ul></div>
        )}
        {o.duplicates.length > 0 && (
          <div><h3 className="mb-1 text-sm font-medium">Duplicate SEO titles (admin-set)</h3>
            <ul className="space-y-1 text-sm">{o.duplicates.map((d) => <li key={`${d.kind}-${d.value}`}><Badge variant="secondary">{d.kind}</Badge> “{d.value}” used {d.count}×</li>)}</ul></div>
        )}
      </section>
    </div>
  );
}
