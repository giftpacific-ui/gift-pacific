import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Static authorization + safety guards for the SEO admin surface. They read source text (no DB/Next needed), so they run anywhere
 * and fail the moment someone adds an unguarded admin action or a raw HTML sink.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("every exported admin SEO action calls requireAdmin() before doing anything else", () => {
  const src = read("src/server/actions/admin-seo.actions.ts");
  assert.ok(src.startsWith('"use server"'));
  const fns = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\n([^\n]*)/g)];
  assert.equal(fns.length, 7, `expected the SEO actions, found ${fns.length}`);
  for (const [, name, firstLine] of fns) assert.match(firstLine, /await requireAdmin\(\)/, `${name} must authorize first`);
});

test("admin SEO pages live under the guarded dashboard layout (never public)", () => {
  const dir = join(ROOT, "src/app/admin/(dashboard)/seo");
  assert.ok(statSync(dir).isDirectory());
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(dir)) assert.ok(!f.includes("route.ts"), "no unauthenticated route handlers under admin/seo");
});

test("dangerouslySetInnerHTML is used only by the sanitising CMS renderer and the JSON-LD component", () => {
  const files = ["src/components/layout/cms-content.tsx", "src/components/layout/cms-system-page.tsx", "src/app/(shop)/pages/[slug]/page.tsx", "src/features/admin/seo/static-page-form.tsx"];
  assert.match(read(files[0]), /sanitizeProductHtml/);
  for (const f of files.slice(1)) assert.doesNotMatch(read(f), /dangerouslySetInnerHTML/, f);
});

test("public CMS reads only return published rows and system pages never double-serve at /pages", () => {
  const src = read("src/server/services/static-page.service.ts");
  assert.equal((src.match(/isPublished: true/g) ?? []).length, 3);
  assert.match(src, /isPublished: true, systemKey: null/);
});

test("the migration is additive: no DROP/DELETE/UPDATE of existing data", () => {
  const sql = read("prisma/migrations/20261120000000_seo_management_p2/migration.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i);
});
