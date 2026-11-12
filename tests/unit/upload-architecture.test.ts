import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Guards the architecture that fixed "Maximum array nesting exceeded": image bytes must never be put into a string /
// Server Action argument. Everything uploads through ONE shared pipeline.

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
const read = (p: string) => readFileSync(p, "utf8");

test("no source file reads an image as base64 / data URL or uses FileReader", () => {
  const offenders: string[] = [];
  for (const f of walk("src")) {
    if (!/\.(tsx?)$/.test(f)) continue;
    const t = read(f);
    if (/readAsDataURL|new FileReader|readFileAsDataUrl|uploadImageAction|validateImageDataUrl|toString\(\s*["']base64["']\s*\)/.test(t)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(!existsSync("src/lib/cloudinary/read-file.ts"));
});

test("every admin image field goes through the shared uploadImageFile pipeline", () => {
  for (const f of ["src/features/admin/single-image-uploader.tsx", "src/features/admin/gallery-image-uploader.tsx"]) {
    assert.match(read(f), /uploadImageFile/, f);
  }
  // and nothing else calls Cloudinary's upload API from the browser outside the shared module
  const callers = [...walk("src")].filter((f) => /api\.cloudinary\.com|uploadFileToCloudinary/.test(read(f)));
  assert.deepEqual(callers.map((f) => f.replaceAll("\\", "/")).sort(), [
    "src/lib/cloudinary/browser-upload.ts",
    "src/lib/cloudinary/cloudinary.ts",
    "src/lib/cloudinary/upload-image.ts",
  ]);
});

test("the Server Action takes only a folder and a short name hint - no file content - and the secret stays server-only", () => {
  const actions = read("src/server/actions/upload.actions.ts");
  assert.match(actions, /createUploadSignatureAction\(\s*folder: UploadFolder,\s*(\/\*\*[^*]*\*\/\s*)?nameHint\?: string/);
  assert.ok(!/dataUrl|base64/i.test(actions));
  // the browser-side modules never see the secret or import the server-only module at runtime
  for (const f of ["src/lib/cloudinary/browser-upload.ts", "src/lib/cloudinary/upload-image.ts", "src/lib/cloudinary/image-loader.ts"]) {
    const t = read(f);
    assert.ok(!/API_SECRET|api_secret/.test(t), f);
    assert.ok(!/from "@\/lib\/cloudinary\/cloudinary"/.test(t.replace(/import type[^\n]*\n/g, "")), f);
  }
  assert.match(read("src/lib/cloudinary/cloudinary.ts"), /^import "server-only";/);
});

test("the arguments of the upload Server Action stay far below React's 1,000,000-character decoder budget", async () => {
  const base = "node_modules/next/dist/compiled/react-server-dom-webpack-experimental";
  assert.ok(existsSync(base), "react-server-dom copy present");
  // The args that actually cross the wire for ANY image size: ("products", "<name>") - a few dozen bytes.
  const args = JSON.stringify(["products", "A product name".repeat(8)]);
  assert.ok(args.length < 1000);
});
