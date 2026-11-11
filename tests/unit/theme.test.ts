import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BRAND_PRIMARY, BRAND_SECONDARY, resolveThemeOverrides, themeFormDefaults } from "@/lib/theme";

test("REGRESSION: the old database defaults (sage #829265 / #f6f1ea) no longer override the new palette", () => {
  assert.deepEqual(resolveThemeOverrides({ primaryColor: "#829265", secondaryColor: "#f6f1ea" }), { primary: null, secondary: null });
  assert.deepEqual(resolveThemeOverrides({ primaryColor: "#829265".toUpperCase().replace("#", "#"), secondaryColor: "#F6F1EA" }), { primary: null, secondary: null }); // case-insensitive
});

test("genuinely customised colors are respected", () => {
  assert.deepEqual(resolveThemeOverrides({ primaryColor: "#112233", secondaryColor: "#ddeeff" }), { primary: "#112233", secondary: "#ddeeff" });
  assert.deepEqual(resolveThemeOverrides({ primaryColor: "#112233", secondaryColor: null }), { primary: "#112233", secondary: null });
});

test("unset / invalid values are ignored (they can never inject CSS)", () => {
  for (const bad of [null, undefined, "", "  ", "red", "#12345", "#GGGGGG", "#112233; background:url(x)", "url(javascript:x)", "#1122334"]) {
    assert.equal(resolveThemeOverrides({ primaryColor: bad }).primary, null, String(bad));
  }
});

test("the settings form pre-fills the brand palette for legacy/unset values and keeps real choices", () => {
  assert.deepEqual(themeFormDefaults({ primaryColor: "#829265", secondaryColor: "#f6f1ea" }), { primaryColor: BRAND_PRIMARY, secondaryColor: BRAND_SECONDARY });
  assert.deepEqual(themeFormDefaults({ primaryColor: null, secondaryColor: null }), { primaryColor: BRAND_PRIMARY, secondaryColor: BRAND_SECONDARY });
  assert.deepEqual(themeFormDefaults({ primaryColor: "#112233", secondaryColor: "#ddeeff" }), { primaryColor: "#112233", secondaryColor: "#ddeeff" });
});

test("brand colors in code, CSS tokens, schema defaults and migrations agree", () => {
  const root = process.cwd();
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  assert.match(css, new RegExp(`--color-sage: ${BRAND_PRIMARY.toLowerCase()}`));
  assert.match(css, new RegExp(`--color-sand: ${BRAND_SECONDARY.toLowerCase()}`));
  const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  assert.match(schema, new RegExp(`primaryColor\\s+String\\?\\s+@default\\("${BRAND_PRIMARY}"\\)`));
  assert.match(schema, new RegExp(`secondaryColor\\s+String\\?\\s+@default\\("${BRAND_SECONDARY}"\\)`));
  const dir = path.join(root, "prisma/migrations");
  const sql = readdirSync(dir).filter((d) => !d.endsWith(".toml")).sort().map((d) => readFileSync(path.join(dir, d, "migration.sql"), "utf8")).join("\n");
  // the LAST statement setting each default must be the brand value, and no UPDATE rewrites stored colors
  const lastPrimary = [...sql.matchAll(/"primaryColor"[^;]*?SET DEFAULT '([^']+)'/g)].pop()?.[1];
  assert.equal(lastPrimary, BRAND_PRIMARY);
  assert.ok(!/UPDATE\s+"StoreSettings"/i.test(sql), "migrations must not rewrite stored store settings");
});
