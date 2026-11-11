import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findProductionConfigProblems } from "@/lib/production-checks";

const good = { NODE_ENV: "production", AUTH_SECRET: "x".repeat(10) + "Aa1!".repeat(8), NEXT_PUBLIC_APP_URL: "https://shop.example", DATABASE_URL: "postgresql://u:p@db.example/giftpacific" };
const critical = (env: Record<string, string>) => findProductionConfigProblems(env).filter((p) => p.severity === "critical");

test("a correct production environment reports nothing", () => {
  assert.deepEqual(findProductionConfigProblems(good), []);
});

test("development is never checked", () => {
  assert.deepEqual(findProductionConfigProblems({ NODE_ENV: "development" }), []);
  assert.deepEqual(findProductionConfigProblems({}), []);
});

test("placeholder / short / missing AUTH_SECRET is CRITICAL (the .env.example value used to pass min(16))", () => {
  for (const secret of ["replace-with-a-long-random-string", "REPLACE-WITH-A-LONG-RANDOM-STRING", "changeme", "", "tooshort-secret-value-123"]) {
    assert.ok(critical({ ...good, AUTH_SECRET: secret }).some((p) => /AUTH_SECRET/.test(p.message)), secret);
  }
  assert.ok(!critical({ ...good }).length);
});

test("localhost / missing / non-https public URL is flagged", () => {
  assert.ok(critical({ ...good, NEXT_PUBLIC_APP_URL: "http://localhost:3000" }).length);
  assert.ok(critical({ ...good, NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" }).length);
  const missing = { ...good } as Record<string, string | undefined>;
  delete missing.NEXT_PUBLIC_APP_URL;
  assert.ok(findProductionConfigProblems(missing as never).some((p) => p.severity === "critical" && /APP_URL/.test(p.message)));
  const http = findProductionConfigProblems({ ...good, NEXT_PUBLIC_APP_URL: "http://shop.example" });
  assert.deepEqual(http.map((p) => p.severity), ["warning"]);
});

test("enabling the unverified courier produces a reminder; a missing webhook secret is flagged", () => {
  const r = findProductionConfigProblems({ ...good, COURIER_PROVIDER: "steadfast" });
  assert.equal(r.length, 2);
  assert.ok(r.every((p) => p.severity === "warning"));
  assert.equal(findProductionConfigProblems({ ...good, COURIER_PROVIDER: "steadfast", COURIER_WEBHOOK_SECRET: "s" }).length, 1);
  assert.deepEqual(findProductionConfigProblems({ ...good, COURIER_PROVIDER: "none" }), []);
});

test("messages never contain the secret values themselves", () => {
  const env = { ...good, AUTH_SECRET: "super-secret-value-that-is-too-short", DATABASE_URL: "" };
  assert.ok(!JSON.stringify(findProductionConfigProblems(env)).includes("super-secret-value"));
});

test(".env.example no longer ships a usable AUTH_SECRET placeholder", () => {
  const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.match(example, /^AUTH_SECRET=""$/m);
  assert.ok(!example.includes("replace-with-a-long-random-string\""));
});

test("Phase 7.3: unverified integrations are flagged when switched on, and the safe defaults report nothing", () => {
  assert.deepEqual(findProductionConfigProblems({ ...good, COURIER_AUTO_BOOK: "false", BKASH_ENABLED: "false", FRAUD_CHECK_PROVIDER: "none" }), []);
  assert.ok(findProductionConfigProblems({ ...good, COURIER_AUTO_BOOK: "true" }).some((p) => /COURIER_AUTO_BOOK=true books real parcels/.test(p.message)));
  assert.ok(findProductionConfigProblems({ ...good, COURIER_AUTO_BOOK: "true", CRON_SECRET: "short" }).some((p) => /CRON_SECRET/.test(p.message)));
  assert.equal(critical({ ...good, BKASH_ENABLED: "true" }).length, 1);
  assert.equal(critical({ ...good, BKASH_ENABLED: "true", BKASH_ENV: "production" }).length, 2);
  assert.ok(findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "someone" }).some((p) => /unsupported value \(supported: steadfast\)/.test(p.message)));
});

test(".env.example ships no real or default credentials and keeps risky integrations off", () => {
  const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.ok(!/postgres:postgres/.test(example));
  assert.match(example, /^COURIER_AUTO_BOOK="false"$/m);
  assert.ok(!/^BKASH_ENABLED="true"/m.test(example));
  assert.ok(!/^FRAUD_CHECK_PROVIDER=/m.test(example));   // stays unset (commented out)
});

test("Phase 7.4: a fraud-check credential without a provider, and malformed tuning numbers, are flagged without echoing values", () => {
  assert.deepEqual(findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "none", FRAUD_CHECK_TIMEOUT_MS: "3000", FRAUD_CHECK_CACHE_SECONDS: "600" }), []);
  const keyOnly = findProductionConfigProblems({ ...good, FRAUD_CHECK_API_KEY: "super-secret-value-123" });
  assert.ok(keyOnly.some((p) => /FRAUD_CHECK_API_KEY is set but FRAUD_CHECK_PROVIDER is not/.test(p.message)));
  assert.ok(!JSON.stringify(keyOnly).includes("super-secret-value-123"));
  const bad = findProductionConfigProblems({ ...good, FRAUD_CHECK_TIMEOUT_MS: "fast", FRAUD_CHECK_CACHE_SECONDS: "1.5", FRAUD_CHECK_MAX_CALLS_PER_MINUTE: "many" });
  assert.equal(bad.filter((p) => /is not a whole number/.test(p.message)).length, 3);
});

test("Phase 7.4: FRAUD_CHECK_PROVIDER=steadfast reuses the courier credentials, says what is wrong with them, and never echoes values", () => {
  const creds = { STEADFAST_API_KEY: "key-value-abc123", STEADFAST_API_SECRET: "secret-value-xyz789" };
  const none = findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "steadfast" });
  assert.ok(none.some((p) => /reuses the Steadfast courier credentials, but they are not usable/.test(p.message)));
  const partial = findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "steadfast", STEADFAST_API_KEY: creds.STEADFAST_API_KEY });
  assert.ok(partial.some((p) => /STEADFAST_API_SECRET/.test(p.message) && /not usable/.test(p.message)));
  const off = findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "steadfast", ...creds, STEADFAST_ENABLED: "false" });
  assert.ok(off.some((p) => /Switched off \(STEADFAST_ENABLED=false\)/.test(p.message)));
  const ok = findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "steadfast", ...creds });
  assert.equal(ok.filter((p) => /not usable/.test(p.message)).length, 0);
  assert.ok(ok.some((p) => /has not been verified against a live call/.test(p.message)));        // a standing reminder until a live check is done
  assert.ok(!JSON.stringify([none, partial, off, ok]).includes("key-value-abc123") && !JSON.stringify([none, partial, off, ok]).includes("secret-value-xyz789"));
  assert.deepEqual(findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "steadfast", ...creds, FRAUD_CHECK_ENABLED: "false" }).filter((p) => /FRAUD_CHECK|Steadfast fraud/.test(p.message)), []);   // switched off: nothing to warn about
});

test("Phase 7.4: a separate FRAUD_CHECK_API_KEY is flagged as ignored by the steadfast provider (no duplicate credentials)", () => {
  const msgs = findProductionConfigProblems({ ...good, FRAUD_CHECK_PROVIDER: "steadfast", STEADFAST_API_KEY: "k-1234567890", STEADFAST_API_SECRET: "s-1234567890", FRAUD_CHECK_API_KEY: "dup-key-999" }).map((p) => p.message);
  assert.ok(msgs.some((m) => /FRAUD_CHECK_API_KEY is set but the steadfast provider ignores it/.test(m)));
  assert.ok(!msgs.join("\n").includes("dup-key-999"));
});
