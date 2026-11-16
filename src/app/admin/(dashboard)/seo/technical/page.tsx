import type { Metadata } from "next";
import Link from "next/link";
import { absoluteUrl, siteOrigin } from "@/lib/seo";
import { buildRobotsTxtRules, ESSENTIAL_PREFIXES } from "@/lib/seo-rules";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { getSitemapIds, getPageSitemapEntries, PRODUCTS_PER_SITEMAP } from "@/server/services/sitemap.service";

export const metadata: Metadata = { title: "Sitemap & robots · Admin" };

export default async function TechnicalSeoPage() {
  const [s, origin, ids, pageEntries] = await Promise.all([getStoreSettings(), getCanonicalOrigin(), getSitemapIds(), getPageSitemapEntries()]);
  const { disallow, rejected } = buildRobotsTxtRules(s.seoRobotsExtra);
  const envOrigin = siteOrigin();
  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">Sitemap</h2>
        <p className="text-sm">Index: <a className="underline" href="/sitemap.xml" target="_blank" rel="noreferrer">{absoluteUrl("/sitemap.xml", origin)}</a></p>
        <p className="text-sm text-muted-foreground">{ids.length} file{ids.length === 1 ? "" : "s"}: one for pages, categories, gift boxes and CMS pages ({pageEntries.length} URLs), plus one per {PRODUCTS_PER_SITEMAP.toLocaleString()} products. It lists only active, indexable pages whose canonical is the page itself, and never admin, account, cart, checkout, login, search or API paths. Generated live from the database.</p>
      </section>
      <section className="space-y-2 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">robots.txt</h2>
        <p className="text-sm"><a className="underline" href="/robots.txt" target="_blank" rel="noreferrer">{absoluteUrl("/robots.txt", origin)}</a></p>
        <p className="text-sm font-medium">Blocked paths</p>
        <ul className="flex flex-wrap gap-1.5 text-xs">{disallow.map((d) => <li key={d} className="rounded bg-secondary px-2 py-1 font-mono">{d}</li>)}</ul>
        {rejected.length > 0 && (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"><p className="font-medium">Ignored extra rules</p>
            <ul className="list-disc pl-5">{rejected.map((r) => <li key={r.line}><code>{r.line}</code> — {r.reason}</li>)}</ul></div>
        )}
        <p className="text-xs text-muted-foreground">Never blocked (protected): {ESSENTIAL_PREFIXES.join(", ")}. Edit extra rules in <Link className="underline" href="/admin/seo/settings">Global settings</Link>.</p>
      </section>
      <section className="space-y-2 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">Canonical origin</h2>
        <p className="text-sm">In effect: <code>{origin}</code></p>
        {origin !== envOrigin && <p className="text-sm text-muted-foreground">Differs from the environment value (<code>{envOrigin}</code>). Product and category structured data still use the environment value, so keep the two the same unless you are mid-migration.</p>}
        {s.seoDefaultNoIndex && <p role="alert" className="text-sm text-destructive">Site-wide noindex is ON.</p>}
        <p className="text-xs text-muted-foreground">This page reports what this site serves. It does not check what Google has indexed.</p>
      </section>
    </div>
  );
}
