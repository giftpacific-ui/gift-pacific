#!/usr/bin/env node
/**
 * Branding guard: fails when the discontinued brand comes back into active files.
 *
 *   pnpm check:branding
 *
 * What it checks (see HANDOFF_GIFTPACIFIC.md → "Branding guard"):
 *   1. Text of every file outside node_modules/.next/.git (source, tests, scripts, docs, config, public text assets).
 *   2. File and directory NAMES.
 *   3. Binary assets (png/jpg/ico/webp/…): embedded metadata strings are scanned as latin1 text. Pixels are NOT inspected.
 *   4. SHA-256 fingerprints of retired brand assets (old logo and favicon) so they cannot be re-added unnoticed.
 *
 * Exceptions:
 *   - prisma/migrations/** (history is never rewritten; applied migrations keep their names/contents).
 *   - A line containing `branding-guard:allow`, or the line right after it, is ignored (use for documented legacy compatibility).
 *   - Lines between `branding-guard:allow-start` and `branding-guard:allow-end` are ignored.
 *
 * The patterns below are written with character classes so that this file does not match itself.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Old-brand patterns (case-insensitive). `id` is shown in reports. */
export const PATTERNS = [
  // The standalone old brand word (any case, also as a prefix such as <word>_x or <word>-x) — but not words that merely contain it.
  { id: "old-brand-word", re: /(?<![a-z])au[r]a(?![a-z])/i },
  // The old brand name in any spelling: with "&", "and", "-", "_", no separator at all (domains, camelCase) or the known typo.
  { id: "old-brand-name", re: /au[r]a[a-z\s_&;-]{0,12}(?:pet[a]ls|pat[e]ls)/i },
  // Legacy storage/cookie identifiers derived from the old abbreviation. Only allowed with an explicit marker.
  { id: "legacy-ap-identifier", re: /(?<![a-z0-9])a[p]_(?:order_conf|purchase_tracked|popup)/i },
];

/** SHA-256 of retired brand assets. A file with one of these hashes must not exist anywhere in the repository. */
export const RETIRED_ASSET_SHA256 = {
  "ddb2cf1849ef96fff5458f07cfe204a0d3d89c411d3db30981e2ceb7739bb7be": "retired logo (public/images/logo.png)",
  "cdbb3a536d6802aa0929f4e812dd1d9c50873bf8fa665f47039c748de1157426": "retired favicon (src/app/favicon.ico)",
};

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "out", "build", ".vercel", ".turbo"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "tsconfig.tsbuildinfo"]);
const MIGRATIONS_PREFIX = "prisma/migrations/";
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".mp4", ".webm"]);
/** `branding-guard:allow` but not the -start / -end block markers. */
const SINGLE_MARKER = /branding-guard:allow(?!-)/;
const MAX_BYTES = 20 * 1024 * 1024;

function findIn(text) {
  const hits = [];
  for (const { id, re } of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ id, match: m[0] });
  }
  return hits;
}

function* walk(root, rel = "") {
  for (const name of readdirSync(path.join(root, rel))) {
    const childRel = rel ? `${rel}/${name}` : name;
    const full = path.join(root, childRel);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(root, childRel);
    } else if (st.isFile()) {
      yield { rel: childRel, full, size: st.size };
    }
  }
}

/**
 * Scans `root` and returns violations: [{ file, line, kind, id, match }].
 * `options.retiredHashes` overrides the fingerprint list (used by tests).
 */
export function scan(root, options = {}) {
  const retired = options.retiredHashes ?? RETIRED_ASSET_SHA256;
  const violations = [];
  for (const { rel, full, size } of walk(root)) {
    if (SKIP_FILES.has(path.basename(rel))) continue;
    const inMigrations = rel.startsWith(MIGRATIONS_PREFIX);

    // 2. names (every path segment of non-migration files)
    if (!inMigrations) {
      const [nameHit] = findIn(rel.split("/").join(" / "));
      if (nameHit) violations.push({ file: rel, line: 0, kind: "filename", ...nameHit });
    }
    if (size > MAX_BYTES) continue;
    const buf = readFileSync(full);

    // 4. fingerprints apply everywhere, migrations included
    const sha = createHash("sha256").update(buf).digest("hex");
    if (retired[sha]) violations.push({ file: rel, line: 0, kind: "retired-asset", id: "retired-asset", match: retired[sha] });
    if (inMigrations) continue;

    // 1 + 3. content (binary files are read as latin1 so embedded metadata strings are visible)
    const binary = BINARY_EXT.has(path.extname(rel).toLowerCase());
    const lines = buf.toString(binary ? "latin1" : "utf8").split(/\r?\n/);
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("branding-guard:allow-start")) inBlock = true;
      const allowed = inBlock || SINGLE_MARKER.test(line) || (i > 0 && SINGLE_MARKER.test(lines[i - 1]));
      if (line.includes("branding-guard:allow-end")) inBlock = false;
      if (allowed) continue;
      const [hit] = findIn(line);
      if (hit) {
        violations.push({ file: rel, line: i + 1, kind: binary ? "binary-metadata" : "content", ...hit });
        if (binary) break; // one finding per binary file is enough
      }
    }
  }
  return violations;
}

function main() {
  const root = process.cwd();
  const violations = scan(root);
  if (violations.length === 0) {
    console.log("check:branding OK — no unintended old-brand references.");
    return;
  }
  console.error(`check:branding FAILED — ${violations.length} unintended old-brand reference(s). The active brand is Gift Pacific.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? `:${v.line}` : ""}  [${v.kind}/${v.id}]  ${JSON.stringify(v.match)}`);
  }
  console.error(
    "\nFix the text, or — only for documented legacy compatibility — add a `branding-guard:allow` marker (see scripts/check-branding.mjs).",
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
