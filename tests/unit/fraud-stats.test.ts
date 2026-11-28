import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeCustomerStats, maskEmail, maskPhone, type StatOrder } from "@/lib/fraud/customer-stats";
import { bucketByDay, repeatGroups } from "@/server/services/fraud-report.service";

const o = (over: Partial<StatOrder>): StatOrder => ({ status: "DELIVERED", total: 100, riskLevel: null, riskReviewDecision: null, riskReviewedLevel: null, events: [], ...over });

test("customer statistics: each number follows its documented definition", () => {
  const s = computeCustomerStats([
    o({ status: "DELIVERED", total: 500, events: ["CONFIRMED", "DELIVERED"] }),
    o({ status: "DELIVERED", total: 700, events: ["CONFIRMED", "FAILED_DELIVERY", "DELIVERED"] }), // failed once, delivered on retry: counts in BOTH
    o({ status: "CANCELLED", total: 300, events: [] }),
    o({ status: "REFUNDED", total: 900, events: ["CONFIRMED", "DELIVERED"] }), // delivered then refunded: delivered, but not 'successful value'
    o({ status: "FAILED_DELIVERY", total: 200, events: ["CONFIRMED", "FAILED_DELIVERY"], riskLevel: "HIGH", riskReviewDecision: "APPROVED", riskReviewedLevel: "HIGH" }),
    o({ status: "CANCELLED", total: 50, events: [], riskLevel: "CRITICAL", riskReviewDecision: "REJECTED", riskReviewedLevel: "CRITICAL" }),
  ]);
  assert.deepEqual([s.total, s.confirmed, s.delivered, s.cancelled, s.failedDelivery], [6, 4, 3, 2, 2]);
  assert.equal(s.successfulValue, 1200);
  assert.equal(s.cancellationRate, 0.333);
  assert.equal(s.failedDeliveryRate, 0.4); // 2 / (3 delivered + 2 failed)
  assert.deepEqual([s.fraudRejected, s.highRisk, s.criticalRisk, s.overriddenApprovals], [1, 1, 1, 1]);
  assert.equal(s.refusedCod, null, "not recorded by the system, so never invented");
});

test("rates are null (not 0, not NaN) when there is nothing to divide by", () => {
  const s = computeCustomerStats([]);
  assert.deepEqual([s.total, s.cancellationRate, s.failedDeliveryRate, s.successfulValue], [0, null, null, 0]);
  assert.equal(computeCustomerStats([o({ status: "PENDING", events: [] })]).failedDeliveryRate, null);
});

test("masking: reports never print a full phone number or e-mail local part", () => {
  assert.equal(maskPhone("01711000001"), "0171****001");
  assert.equal(maskPhone("-"), "unknown");
  assert.equal(maskPhone(null), "unknown");
  assert.equal(maskEmail("jane.doe@example.com"), "j***@example.com");
  assert.equal(maskEmail("nope"), "****");
});

test("report helpers: day buckets cover every day of the range; repeat groups keep only keys at/over the minimum, most frequent first, ignoring unknown keys", () => {
  const from = new Date("2026-11-14T08:00:00Z"), to = new Date("2026-11-20T10:00:00Z");
  const b = bucketByDay([
    { createdAt: new Date("2026-11-14T23:59:00Z"), riskLevel: "HIGH" }, { createdAt: new Date("2026-11-15T00:01:00Z"), riskLevel: "CRITICAL" },
    { createdAt: new Date("2026-11-20T09:00:00Z"), riskLevel: "HIGH" }, { createdAt: new Date("2026-11-20T09:00:00Z"), riskLevel: "LOW" }, { createdAt: new Date("2026-11-01T00:00:00Z"), riskLevel: "HIGH" },
  ], from, to);
  assert.equal(b.length, 7);
  assert.deepEqual(b[0], { date: "2026-11-14", high: 1, critical: 0 });
  assert.deepEqual(b[1], { date: "2026-11-15", high: 0, critical: 1 });
  assert.deepEqual(b.at(-1), { date: "2026-11-20", high: 1, critical: 0 });
  const g = repeatGroups([{ key: "a", orderNumber: "1" }, { key: "b", orderNumber: "2" }, { key: "a", orderNumber: "3" }, { key: "a", orderNumber: "4" }, { key: null, orderNumber: "5" }, { key: "-", orderNumber: "6" }, { key: "b", orderNumber: "7" }], 2);
  assert.deepEqual(g.map((x) => [x.key, x.count]), [["a", 3], ["b", 2]]);
  assert.deepEqual(g[0].orderNumbers, ["1", "3", "4"]);
});

// ------------------------------------------------------------------------------------------------ static security / consistency guards
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

test("SECURITY GUARD: every fraud admin page and every fraud admin action enforces the admin role on the server", () => {
  const pages = walk("src/app/admin/(dashboard)/fraud").filter((f) => f.endsWith("page.tsx"));
  assert.ok(pages.length >= 5, `found ${pages.length} fraud pages`);
  for (const f of pages) assert.match(readFileSync(f, "utf8"), /await requireAdmin\(\)/, f);
  const actions = readFileSync("src/server/actions/admin-fraud.actions.ts", "utf8");
  const fns = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(fns.length >= 6);
  for (const fn of fns) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}(`)).split("\nexport async function ")[0];
    assert.match(body, /await requireAdmin\(\)/, `${fn} must call requireAdmin first`);
  }
  assert.match(actions, /^"use server";/);
});

test("PRIVACY GUARD: no customer-facing code (shop pages, non-admin features, components) can read risk data or the fraud services", () => {
  const roots = ["src/app/(shop)", "src/components", "src/features"];
  const banned = /riskScore|riskLevel|riskReview|riskAssess|fraud-risk\.service|fraud-review\.service|customer-risk\.service|risk-list\.service|fraud-report\.service|lib\/fraud\//;
  const offenders: string[] = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      if (f.startsWith("src/features/admin")) continue;
      if (banned.test(readFileSync(f, "utf8"))) offenders.push(f);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the API routes for maintenance require the shared bearer secret, like the other scheduled jobs", () => {
  const r = readFileSync("src/app/api/fraud/maintenance/route.ts", "utf8");
  assert.match(r, /verifyBearerSecret\(/);
  assert.match(r, /CRON_SECRET/);
});

test("STATIC schema/migration check for P4 (Prisma validate is unavailable offline): every column and table in the migration exists in schema.prisma and the migration is additive", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const model = (name: string) => new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
  const sql = readFileSync("prisma/migrations/20261124000000_fraud_p4/migration.sql", "utf8");
  const code = sql.replace(/--.*$/gm, "");
  let checked = 0;
  for (const m of code.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
    for (const c of m[2].matchAll(/^\s+"(\w+)"/gm)) { assert.match(model(m[1]), new RegExp(`\\n\\s+${c[1]}\\s`), `${m[1]}.${c[1]}`); checked++; }
  }
  for (const m of code.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN([\s\S]*?);/g)) {
    for (const c of m[2].matchAll(/(?:^|\n|,)\s*(?:ADD COLUMN\s+)?"(\w+)"\s+(?:TEXT|TIMESTAMP|INTEGER|JSONB|BOOLEAN|"\w+")/g)) { assert.match(model(m[1]), new RegExp(`\\n\\s+${c[1]}\\s`), `${m[1]}.${c[1]}`); checked++; }
  }
  // 14 Order + 1 StoreSettings + 11 OrderRiskAssessment + 12 RiskListEntry
  assert.equal(checked, 38, "the parser must have seen every column");
  for (const e of ["RiskLevel", "RiskReviewDecision", "RiskListType", "RiskListKind"]) assert.match(schema, new RegExp(`enum ${e} \\{`));
  const withoutFkActions = code.replace(/ON (?:DELETE|UPDATE) (?:CASCADE|RESTRICT|SET NULL|NO ACTION)/g, ""); // referential actions are not data changes
  assert.ok(!/\bDROP\b|\bDELETE\b|\bUPDATE\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN/i.test(withoutFkActions), "additive only");
  // ...and the check itself can fail: a destructive statement is caught.
  assert.ok(/\bDROP\b/i.test("ALTER TABLE x DROP COLUMN y;") && /\bUPDATE\b/i.test("UPDATE \"Order\" SET x = 1;"));
  assert.match(code, /"riskReviewRequired" BOOLEAN NOT NULL DEFAULT false/, "the only NOT NULL addition to Order has a default, so existing rows stay valid");
  assert.match(code, /CREATE UNIQUE INDEX "Order_checkoutKey_key"/);
});
