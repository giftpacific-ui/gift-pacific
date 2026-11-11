import type { AttributeDefFull } from "@/server/services/attribute.service";

/**
 * Filters for attributes an admin marked "filterable". A plain GET form (works without
 * JavaScript): values travel as `a.<slug>=…` and are re-validated on the server against the
 * attribute definitions, so nothing here is trusted.
 */
export function AttributeFilters({
  defs,
  params,
  basePath,
}: {
  defs: AttributeDefFull[];
  params: Record<string, string | string[] | undefined>;
  basePath: string;
}) {
  if (defs.length === 0) return null;
  const current = (slug: string) => {
    const v = params[`a.${slug}`];
    return (Array.isArray(v) ? v.join(",") : v ?? "").split(",").filter(Boolean);
  };
  // keep every non-attribute param (sort, category search, kind, price…) when the form is submitted
  const keep = Object.entries(params).filter(([k, v]) => !k.startsWith("a.") && k !== "page" && typeof v === "string") as [string, string][];
  return (
    <form method="get" action={basePath} className="space-y-5 border-t border-border pt-6" aria-label="Filter by specifications">
      {keep.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {defs.map((d) => (
        <fieldset key={d.id} className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{d.name}{d.unit ? ` (${d.unit})` : ""}</legend>
          {(d.valueType === "SELECT" || d.valueType === "MULTI_SELECT") && (
            <div className="space-y-1.5">
              {d.options.map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-sm">
                  {/* repeated names are joined by the server parser */}
                  <input type="checkbox" name={`a.${d.slug}`} value={o.value} defaultChecked={current(d.slug).includes(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
          )}
          {d.valueType === "BOOLEAN" && (
            <select name={`a.${d.slug}`} defaultValue={current(d.slug)[0] ?? ""} className="h-9 w-full rounded-[4px] border border-input bg-background px-2 text-sm">
              <option value="">Any</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          )}
          {d.valueType === "NUMBER" && (
            <p className="text-xs text-muted-foreground">
              Range, e.g. <code>10..50</code>
              <input name={`a.${d.slug}`} defaultValue={current(d.slug)[0] ?? ""} inputMode="decimal" placeholder="min..max" className="mt-1 h-9 w-full rounded-[4px] border border-input bg-background px-2 text-sm" aria-label={`${d.name} range`} />
            </p>
          )}
        </fieldset>
      ))}
      <button type="submit" className="h-9 w-full rounded-[4px] border border-foreground text-sm font-medium hover:bg-foreground hover:text-background">Apply</button>
    </form>
  );
}
