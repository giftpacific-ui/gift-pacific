import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error plain ESM script without type declarations
import { scan, RETIRED_ASSET_SHA256 } from "../../scripts/check-branding.mjs";

// Old-brand strings are assembled at runtime so this test file never contains them literally.
const A = ["au", "ra"].join("");
const P = ["pet", "als"].join("");
const variants = [
  `${A} & ${P}`, `${A}-and-${P}`, `${A}_${P}`, `${A}${P}.com`, `Au${"ra"}Pet${"als"}`, `Au${"ra"}And${P}`, `${A}_consent_v1`, `${A}-x`, `the ${A}.`,
  ["a", "p"].join("") + "_order_conf",
];

function repo(files: Record<string, string | Buffer>): { root: string; done: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "brand-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("the real repository has no unintended old-brand references", () => {
  assert.deepEqual(scan(process.cwd()), []);
});

test("every old-brand spelling is detected in active source", () => {
  for (const v of variants) {
    const r = repo({ "src/a.ts": `const x = "${v}";\n` });
    try {
      const found = scan(r.root);
      assert.equal(found.length >= 1, true, `not detected: ${v}`);
      assert.equal(found[0].file, "src/a.ts");
      assert.equal(found[0].line, 1);
    } finally {
      r.done();
    }
  }
});

test("harmless words and the new brand are not flagged", () => {
  const r = repo({
    "src/a.ts": ["restaurant", "Laura", "centaur", `rose ${P}`, "Gift Pacific", "giftpacific_consent_v1", "AP-202610-000123"].join("\n"),
    "docs.txt": "Welcome to Gift Pacific",
  });
  try {
    assert.deepEqual(scan(r.root), []);
  } finally {
    r.done();
  }
});

test("migration history is exempt (contents and directory names)", () => {
  const r = repo({ [`prisma/migrations/20261113000000_brand_default_${A}_${P}/migration.sql`]: `-- ${A} & ${P}\n` });
  try {
    assert.deepEqual(scan(r.root), []);
  } finally {
    r.done();
  }
});

test("file and directory names are checked", () => {
  const r = repo({ [`public/${A}-${P}-banner.txt`]: "ok", [`src/${A}/x.ts`]: "ok" });
  try {
    const kinds = scan(r.root).map((v: { kind: string }) => v.kind);
    assert.deepEqual(kinds, ["filename", "filename"]);
  } finally {
    r.done();
  }
});

test("marked exceptions are honoured: same line, next line and blocks; unmarked lines still fail", () => {
  const r = repo({
    "src/a.ts": [
      `const a = "${A}_x"; // branding-guard:allow`,
      "// branding-guard:allow",
      `const b = "${A}_y";`,
      `const c = "${A}_z";`,
    ].join("\n"),
    "NOTES.md": ["<!-- branding-guard:allow-start -->", `${A} & ${P}`, "<!-- branding-guard:allow-end -->", `${A} & ${P}`].join("\n"),
  });
  try {
    const found = scan(r.root).map((v: { file: string; line: number }) => `${v.file}:${v.line}`).sort();
    assert.deepEqual(found, ["NOTES.md:4", "src/a.ts:4"]);
  } finally {
    r.done();
  }
});

test("binary metadata strings are scanned; fingerprints of retired assets are rejected anywhere", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`tEXtTitle\0${A} & ${P}`, "latin1")]);
  const clean = Buffer.from([1, 2, 3, 4, 5]);
  const r = repo({ "public/x.png": png, "public/clean.png": clean, "prisma/migrations/1_a/old.bin": clean });
  try {
    const kinds = scan(r.root).map((v: { file: string; kind: string }) => `${v.file}:${v.kind}`);
    assert.deepEqual(kinds, ["public/x.png:binary-metadata"]);
    const hash = createHash("sha256").update(clean).digest("hex");
    const retired = scan(r.root, { retiredHashes: { [hash]: "test asset" } }).filter((v: { kind: string }) => v.kind === "retired-asset");
    assert.deepEqual(retired.map((v: { file: string }) => v.file).sort(), ["prisma/migrations/1_a/old.bin", "public/clean.png"]);
  } finally {
    r.done();
  }
});

test("the retired asset fingerprint list is well-formed", () => {
  const keys = Object.keys(RETIRED_ASSET_SHA256);
  assert.equal(keys.length, 2);
  for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/);
});
