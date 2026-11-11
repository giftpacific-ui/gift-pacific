import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateNewPassword } from "../../scripts/password-rules";

test("operator password rules", () => {
  assert.deepEqual(validateNewPassword("Str0ng-Temp-Pass", "a@b.co"), { ok: true, password: "Str0ng-Temp-Pass" });
  for (const bad of [undefined, "", "   ", " Leading1Space", "Short1A", "alllowercase123", "ALLUPPERCASE123", "NoDigitsHereAtAll", "contains-JAMIE-Name1"]) {
    assert.equal(validateNewPassword(bad, "jamie@example.com").ok, false, String(bad));
  }
});

test("the script reads the password from the environment (never argv), removes reset tokens, and never prints it", () => {
  const src = readFileSync(path.join(process.cwd(), "scripts/set-user-password.ts"), "utf8");
  assert.match(src, /process\.env\.NEW_PASSWORD/);
  assert.ok(!/process\.argv\[3\]/.test(src), "password must not come from argv");
  assert.match(src, /passwordResetToken\.deleteMany/);
  assert.ok(!/console\.(log|error)\([^)]*check\.password/.test(src));
  assert.match(readFileSync(path.join(process.cwd(), "package.json"), "utf8"), /"user:set-password"/);
});
