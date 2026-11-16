import { Badge } from "@/components/ui/badge";
import { listEntitySeo, type EntityKind, type SeoFilter } from "@/server/services/admin-seo.service";
import { auditSeoRecord, type SeoIssueCode } from "@/lib/seo-rules";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { EntitySeoDialog } from "./entity-seo-dialog";
import { SeoListControls } from "./seo-pager";

const FILTERS: { value: SeoFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "missing-title", label: "No custom SEO title" }, { value: "missing-description", label: "No meta description" },
  { value: "missing-image", label: "No OG image" }, { value: "noindex", label: "Noindex" }, { value: "has-canonical", label: "Has canonical override" },
];
const ISSUE_LABEL: Partial<Record<SeoIssueCode, string>> = {
  "missing-title": "No custom title", "missing-description": "No description", "missing-image": "No image", noindex: "noindex",
  "invalid-canonical": "Invalid canonical", "canonical-elsewhere": "Canonical elsewhere", "long-title": "Long title", "long-description": "Long description",
};

export async function EntitySeoList({ kind, action, q, filter, page }: { kind: EntityKind; action: string; q: string; filter: SeoFilter; page: number }) {
  const [list, origin, settings] = await Promise.all([listEntitySeo(kind, { q, filter, page }), getCanonicalOrigin(), getStoreSettings()]);
  const valid = FILTERS.some((f) => f.value === filter);
  return (
    <div className="space-y-4">
      <SeoListControls action={action} q={q} filter={valid ? filter : "all"} filters={FILTERS} page={list.page} pageCount={list.pageCount} total={list.total} />
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
        {list.items.map((r) => {
          // "No custom title" is informational: the page still gets a title from the record's own name.
          const issues = auditSeoRecord({ title: r.title, description: r.description, image: r.image, noindex: r.noindex, canonical: r.canonical, path: r.path }, origin);
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 space-y-1">
                <p className="truncate font-medium">{r.name}</p>
                <p className="truncate text-xs text-muted-foreground">{r.path}</p>
                <div className="flex flex-wrap gap-1">
                  {issues.length === 0 ? <Badge variant="success">Complete</Badge> : issues.map((i) => <Badge key={i} variant={i === "invalid-canonical" || i === "noindex" ? "destructive" : "secondary"}>{ISSUE_LABEL[i] ?? i}</Badge>)}
                </div>
              </div>
              <EntitySeoDialog kind={kind} id={r.id} name={r.name} path={r.path} origin={origin} siteName={settings.storeName}
                fallbackTitle={r.name}
                initial={{ title: r.title ?? "", description: r.description ?? "", keywords: r.keywords, canonical: r.canonical ?? "", ogTitle: "", ogDescription: "", image: r.seoImageOnly ?? "", noindex: r.noindex, nofollow: false, directives: "" }} />
            </li>
          );
        })}
        {list.items.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">Nothing matches.</li>}
      </ul>
    </div>
  );
}
