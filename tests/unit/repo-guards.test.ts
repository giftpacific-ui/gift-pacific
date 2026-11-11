/**
 * Source-level regression guards for problems that have actually come back
 * after earlier fixes. They read files from disk, so they run without a
 * database or any dependency install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Tests are run from the repository root (`pnpm test`).
const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const srcFiles = walk("src");

test("no login form is pre-filled with credentials (regression)", () => {
  for (const f of ["src/app/admin/login/page.tsx", "src/features/auth/login-form.tsx"]) {
    const text = read(f);
    assert.ok(!text.includes("ChangeMe123"), `${f} contains the default admin password`);
    assert.ok(!/admin@[a-z0-9.-]+\.[a-z]{2,}/i.test(text), `${f} contains a hard-coded admin email`);
    assert.ok(!text.includes("Password123"), `${f} contains the demo customer password`);
    assert.ok(!/jamie@example\.com/.test(text), `${f} pre-fills the demo customer`);
  }
});

test("IMAGE_UPLOAD does not exist anywhere in the schema or source (regression)", () => {
  assert.ok(!read("prisma/schema.prisma").includes("IMAGE_UPLOAD"));
  for (const f of srcFiles) {
    const text = read(f);
    if (f === "src/lib/customization.ts" || f === "src/lib/validations/admin.ts") continue; // explanatory comments only
    assert.ok(!text.includes("IMAGE_UPLOAD"), `${f} references IMAGE_UPLOAD`);
  }
  const code = read("src/lib/customization.ts").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("IMAGE_UPLOAD"));
});

test("no `any` casts crept back into source", () => {
  for (const f of srcFiles) {
    assert.ok(!/\bas any\b|:\s*any\b|<any>/.test(read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), `${f} uses any`);
  }
});

test("no confirmation/reset tokens in URLs, no console.log, no TODO/FIXME", () => {
  for (const f of srcFiles) {
    const text = read(f);
    assert.ok(!/confirmation\/[^`'"\n]*\?token=/.test(text), `${f} puts the confirmation token in a URL`);
    assert.ok(!/console\.log\(/.test(text), `${f} has console.log`);
    assert.ok(!/\b(TODO|FIXME|XXX)\b/.test(text), `${f} has a TODO/FIXME`);
  }
});

test("analytics never reads the query string", () => {
  const text = read("src/lib/analytics/analytics-scripts.tsx");
  assert.ok(!text.includes("useSearchParams"));
  assert.ok(!text.includes("searchParams"));
});

test("every Prisma model/enum/column in schema.prisma is created by the migrations (schema ↔ migration drift)", () => {
  const schema = read("prisma/schema.prisma").replace(/\/\/[^\n]*/g, "");
  const sql = readdirSync(path.join(root, "prisma/migrations"))
    .filter((d) => statSync(path.join(root, "prisma/migrations", d)).isDirectory())
    .sort()
    .map((d) => read(`prisma/migrations/${d}/migration.sql`))
    .join("\n");
  const scalar = /^(String|Int|Boolean|DateTime|Json|Decimal|Float)$/;
  const enums = new Map<string, string[]>();
  for (const m of schema.matchAll(/\benum\s+(\w+)\s*\{([^}]*)\}/g)) enums.set(m[1], m[2].split(/\s+/).filter(Boolean));

  for (const [name, values] of enums) {
    assert.ok(sql.includes(`CREATE TYPE "${name}"`), `enum ${name} missing from migrations`);
    for (const v of values) assert.ok(new RegExp(`'${v}'`).test(sql), `enum value ${name}.${v} missing from migrations`);
  }
  for (const m of schema.matchAll(/\bmodel\s+(\w+)\s*\{(.*?)\n\}/gs)) {
    const [, model, body] = m;
    assert.ok(sql.includes(`CREATE TABLE "${model}"`), `table ${model} missing from migrations`);
    for (const line of body.split("\n")) {
      const f = line.trim().match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
      if (!f || line.trim().startsWith("@@")) continue;
      const [, field, type] = f;
      if (!scalar.test(type) && !enums.has(type)) continue; // relation field
      assert.ok(sql.includes(`"${field}"`), `column ${model}.${field} missing from migrations`);
    }
  }
  assert.ok(sql.includes("CREATE SEQUENCE IF NOT EXISTS \"order_number_seq\""));
});

test("production seed refuses to create demo accounts or default passwords", () => {
  // The rules live in prisma/seed-config.ts (behaviour covered by tests/unit/seed-config.test.ts).
  const config = read("prisma/seed-config.ts");
  assert.match(config, /NODE_ENV/);
  assert.match(config, /SEED_ADMIN_PASSWORD/);
  assert.match(config, /classifyDatabase/);
  assert.match(read("prisma/seed-runner.ts"), /resolveSeedConfig/);
  assert.match(read("prisma/seed.ts"), /runSeed/);
});

// ---------------------------------------------------------------------------
// Storefront redesign guards: the design reference contained mock content
// (fake products/stats/testimonials/newsletter, picsum photos, an invented
// policy). None of it may reach the real storefront.
// ---------------------------------------------------------------------------
const storefrontFiles = srcFiles.filter(
  (f) => !f.startsWith(path.join("src", "app", "admin")) && !f.startsWith(path.join("src", "features", "admin")),
);

test("no placeholder photography or stock-image hosts anywhere in the storefront", () => {
  for (const f of storefrontFiles) {
    const text = read(f);
    assert.ok(!/picsum\.photos|unsplash\.com|placehold\.co|via\.placeholder|loremflickr/i.test(text), `${f} references a placeholder/stock image host`);
  }
});

test("no invented testimonials, statistics or fake customers on the storefront", () => {
  for (const f of storefrontFiles) {
    const text = read(f);
    for (const name of ["Priya M.", "Daniel R.", "Sarah K.", "সজীব", "5,000+", "98%"]) {
      assert.ok(!text.includes(name), `${f} contains invented content: ${name}`);
    }
  }
  assert.ok(!srcFiles.some((f) => f.endsWith("testimonials.tsx")), "the fake Testimonials component is back");
});

test("no fake newsletter form (there is no subscription backend)", () => {
  for (const f of storefrontFiles) {
    const text = read(f);
    assert.ok(!/newsletter/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} mentions a newsletter outside comments`);
  }
});

test("the full-screen 'Loading…' splash and the page-transition flash are gone", () => {
  assert.ok(!srcFiles.some((f) => /GlobalLoader|PageTransition/.test(f)));
  const layout = read("src/app/layout.tsx");
  assert.ok(!/GlobalLoader|PageTransition/.test(layout));
});

test("no placeholder social links or hard-coded category navigation in siteConfig", () => {
  const cfg = read("src/config/site.ts").replace(/\/\/.*$/gm, "");
  assert.ok(!/instagram\.com|facebook\.com|pinterest\.com/.test(cfg));
  assert.ok(!/clay-crafts|gift-boxes|home-decor|personalized-gifts/.test(cfg));
});

test("the product page does not hard-code shipping times or a return window (single source: /shipping-returns)", () => {
  const pdp = read("src/app/(shop)/products/[slug]/page.tsx");
  assert.ok(!/business days|within 14 days|14 days|3[–-]5/i.test(pdp));
  assert.match(pdp, /\/shipping-returns/);
});

test("homepage claims are real: no 'secure checkout / payment details' claim while V1 is COD-only", () => {
  const trust = read("src/features/home/trust-sections.tsx");
  assert.ok(!/encrypted|secure checkout|payment details/i.test(trust));
  assert.match(trust, /Pay on delivery/);
});

test("accessibility basics are present: reduced-motion CSS, focus ring, skip link, labelled carousel controls", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(read("src/app/(shop)/layout.tsx"), /Skip to content/);
  const hero = read("src/features/home/hero.tsx");
  assert.match(hero, /prefers-reduced-motion/);
  assert.match(hero, /Pause automatic slide rotation/);
});

test("product cards defer the hover-video iframe (no iframes mounted at page load)", () => {
  assert.ok(!/<iframe/.test(read("src/features/products/product-card.tsx")));
  assert.match(read("src/features/products/card-hover-video.tsx"), /pointerenter/);
});
