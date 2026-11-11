/** Pure helpers for SEO keyword tags (shared by the admin TagInput, validation and metadata). */
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 60;

/** Splits on commas/newlines, trims, drops empties, caps length, de-duplicates case-insensitively (first spelling wins). */
export function parseKeywordInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n\r;]+/)) {
    const k = part.replace(/\s+/g, " ").trim().slice(0, MAX_KEYWORD_LENGTH).trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** Merge new input into an existing list, respecting the cap. */
export function addKeywords(existing: string[], raw: string): string[] {
  return normalizeKeywords([...existing, ...parseKeywordInput(raw)]);
}

export function normalizeKeywords(list: readonly string[] | null | undefined): string[] {
  return parseKeywordInput((list ?? []).join(",")).slice(0, MAX_KEYWORDS);
}

/** Next.js `metadata.keywords` value; undefined when empty so no empty tag is emitted. */
export function keywordsForMetadata(list: readonly string[] | null | undefined): string[] | undefined {
  const k = normalizeKeywords(list);
  return k.length ? k : undefined;
}
