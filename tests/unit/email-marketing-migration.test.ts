/**
 * Static schema <-> migration consistency for Prompt 07 (e-mail marketing database architecture). NOT a substitute for `prisma validate` /
 * `prisma migrate diff` / running the migration on PostgreSQL (none of them could be run where this was written): it catches drift (a field in one
 * place only, a destructive statement, a missing constraint) and checks the safety properties promised in the migration comments. The constraints
 * are exercised against a real database by tests/integration/email-marketing.postgres.test.ts when TEST_DATABASE_URL is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../prisma/", import.meta.url);
const schema = readFileSync(new URL("schema.prisma", root), "utf8");
const DIR = "20261201000000_email_marketing_architecture_p07";
const raw = readFileSync(new URL(`migrations/${DIR}/migration.sql`, root), "utf8");
const sql = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const NEW_MODELS = ["EmailContact", "MarketingConsent", "EmailSuppression", "EmailTemplate", "EmailCampaign", "EmailCampaignRecipient", "RecoveryEmail"] as const;
const NEW_ENUMS = ["EmailContactSource", "MarketingConsentSource", "MarketingUnsubscribeSource", "EmailSuppressionReason", "EmailTemplateCategory", "EmailCampaignStatus", "EmailDeliveryStatus", "RecoveryEmailKind"] as const;
const modelNames = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);

const model = (name: string) => {
  const m = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `model ${name} exists`);
  return m[1];
};
const enumBody = (name: string) => {
  const m = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `enum ${name} exists`);
  return [...m[1].matchAll(/^\s+([A-Z_]+)/gm)].map((x) => x[1]);
};
/** Scalar (non-relation, non-list) fields of a model: name, optional?, type. */
const scalars = (name: string) =>
  [...model(name).matchAll(/^\s+(\w+)\s+(\w+)(\?|\[\])?(\s|$)/gm)]
    .filter((m) => !m[0].trim().startsWith("//") && !m[0].trim().startsWith("@@"))
    .filter((m) => !modelNames.includes(m[2]) && m[3] !== "[]")
    .map((m) => ({ name: m[1], type: m[2], optional: m[3] === "?" }));
const table = (name: string) => {
  const m = sql.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `CREATE TABLE ${name}`);
  return m[1];
};

test("migration exists, sorts after the courier migrations, and the lock file is untouched", () => {
  const dirs = readdirSync(new URL("migrations/", root)).filter((d) => /^\d{14}_/.test(d)).sort();
  assert.ok(dirs.includes(DIR));
  assert.ok(DIR > "20261130000000_courier_consignment_unique");
  assert.equal(dirs.at(-1), DIR);
  assert.match(readFileSync(new URL("migrations/migration_lock.toml", root), "utf8"), /provider = "postgresql"/);
});

test("ADDITIVE ONLY: no destructive statement, only new tables are created, every ALTER is an ADD CONSTRAINT on a new table", () => {
  // (the referential actions "ON DELETE ..." / "ON UPDATE ..." of the foreign keys are not statements)
  assert.doesNotMatch(sql.replace(/ON (DELETE|UPDATE) /g, ""), /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|RENAME)\b/i);
  const created = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, [...NEW_MODELS].sort());
  const types = [...sql.matchAll(/CREATE TYPE "(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(types, [...NEW_ENUMS].sort());
  const alters = [...sql.matchAll(/ALTER TABLE "(\w+)" (\w+ \w+)/g)];
  assert.ok(alters.length > 0);
  for (const [, t, what] of alters) {
    assert.ok((NEW_MODELS as readonly string[]).includes(t), `ALTER targets a new table, not ${t}`);
    assert.equal(what, "ADD CONSTRAINT");
  }
  for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)"/g)) assert.ok((NEW_MODELS as readonly string[]).includes(m[1]), `index on new table, not ${m[1]}`);
  assert.equal((sql.match(/\(/g) ?? []).length, (sql.match(/\)/g) ?? []).length, "balanced parentheses");
  assert.doesNotMatch(sql, /\$\$/, "no procedural blocks");
});

test("every scalar schema field of the new models is a column with matching nullability, and every column is in the schema", () => {
  for (const name of NEW_MODELS) {
    const t = table(name);
    const fields = scalars(name);
    assert.ok(fields.length >= 5, name);
    for (const f of fields) {
      const col = t.match(new RegExp(`^\\s+"${f.name}" ([^\\n]*)$`, "m"));
      assert.ok(col, `${name}.${f.name} is a column`);
      assert.equal(!/NOT NULL/.test(col[1]), f.optional, `${name}.${f.name} nullability`);
    }
    const cols = [...t.matchAll(/^\s+"(\w+)" [A-Z"]/gm)].map((m) => m[1]);
    assert.deepEqual(cols.sort(), fields.map((f) => f.name).sort(), `${name} columns == schema fields`);
  }
});

test("enums in the schema and the migration list identical values", () => {
  for (const e of NEW_ENUMS) {
    const m = sql.match(new RegExp(`CREATE TYPE "${e}" AS ENUM \\(([^)]*)\\)`));
    assert.ok(m, e);
    const sqlValues = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    assert.deepEqual(sqlValues, enumBody(e), e);
  }
  assert.deepEqual(enumBody("EmailCampaignStatus"), ["DRAFT", "SCHEDULED", "SENDING", "COMPLETED", "CANCELLED", "FAILED"]);
  assert.deepEqual(enumBody("EmailSuppressionReason"), ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "ADMIN"]);
  assert.deepEqual(enumBody("EmailContactSource"), ["MANUAL", "CSV_IMPORT", "CUSTOMER"]);
  assert.deepEqual(enumBody("RecoveryEmailKind"), ["ABANDONED_CART", "INCOMPLETE_CHECKOUT"]);
});

test("unique contact e-mail, unique suppression e-mail, unique template name: schema and SQL agree", () => {
  assert.match(model("EmailContact"), /\n\s+email\s+String\s+@unique/);
  assert.match(sql, /CREATE UNIQUE INDEX "EmailContact_email_key" ON "EmailContact"\("email"\)/);
  assert.match(model("EmailSuppression"), /\n\s+email\s+String\s+@unique/);
  assert.match(sql, /CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"\("email"\)/);
  assert.match(model("EmailTemplate"), /\n\s+name\s+String\s+@unique/);
  assert.match(sql, /CREATE UNIQUE INDEX "EmailTemplate_name_key" ON "EmailTemplate"\("name"\)/);
});

test("addresses are stored normalised: CHECK constraints force trim + lower-case on contacts and suppressions", () => {
  for (const t of ["EmailContact", "EmailSuppression"]) {
    assert.match(table(t), new RegExp(`CONSTRAINT "${t}_email_normalized_check" CHECK \\("email" = lower\\(btrim\\("email"\\)\\)`));
  }
});

test("campaign recipients: one row per (campaign, contact); one EmailJob per recipient; Restrict keeps send history", () => {
  assert.match(model("EmailCampaignRecipient"), /@@unique\(\[campaignId, contactId\]\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "EmailCampaignRecipient_campaignId_contactId_key" ON "EmailCampaignRecipient"\("campaignId", "contactId"\)/);
  assert.match(model("EmailCampaignRecipient"), /\n\s+emailJobId\s+String\?\s+@unique/);
  assert.match(sql, /CREATE UNIQUE INDEX "EmailCampaignRecipient_emailJobId_key" ON "EmailCampaignRecipient"\("emailJobId"\)/);
  assert.match(table("EmailCampaignRecipient"), /CHECK \(\("status" = 'SKIPPED'\) = \("skipReason" IS NOT NULL\)\)/);
});

test("recovery e-mails: (eventKey, step) is unique, the key must match the kind, and the two kinds are distinct", () => {
  assert.match(model("RecoveryEmail"), /@@unique\(\[eventKey, step\]\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "RecoveryEmail_eventKey_step_key" ON "RecoveryEmail"\("eventKey", "step"\)/);
  assert.match(model("RecoveryEmail"), /\n\s+emailJobId\s+String\?\s+@unique/);
  assert.match(table("RecoveryEmail"), /"kind" = 'INCOMPLETE_CHECKOUT' AND "eventKey" LIKE 'ic:%'/);
  assert.match(table("RecoveryEmail"), /"kind" = 'ABANDONED_CART' AND "eventKey" LIKE 'ac:%'/);
  assert.match(table("RecoveryEmail"), /"contactId" TEXT NOT NULL/, "a recovery e-mail always has a contact, so consent and suppression can be checked");
});

test("consent: at most one OPEN consent per contact (partial unique), unsubscribe fields move together and never precede the grant", () => {
  assert.match(sql, /CREATE UNIQUE INDEX "MarketingConsent_contactId_active_key" ON "MarketingConsent"\("contactId"\) WHERE "unsubscribedAt" IS NULL/);
  const t = table("MarketingConsent");
  assert.match(t, /\("unsubscribedAt" IS NULL\) = \("unsubscribeSource" IS NULL\)/);
  assert.match(t, /"unsubscribedAt" >= "grantedAt"/);
  assert.match(t, /"grantedAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.match(sql, /CREATE INDEX "MarketingConsent_contactId_grantedAt_idx"/, "history is queryable per contact");
});

test("checkout progress-saving consent is never marketing consent", () => {
  assert.deepEqual(enumBody("MarketingConsentSource"), ["ADMIN_RECORDED", "CSV_IMPORT", "CUSTOMER_ACCOUNT", "CHECKOUT_MARKETING", "SIGNUP_FORM"]);
  for (const v of enumBody("MarketingConsentSource")) assert.doesNotMatch(v, /PROGRESS|INCOMPLETE|SAVE/);
  const body = model("MarketingConsent");
  assert.doesNotMatch(body, /IncompleteCheckout|incompleteCheckout/);
  assert.doesNotMatch(sql.match(/CREATE TABLE "MarketingConsent"[\s\S]*?\n\);/)![0], /IncompleteCheckout/);
  // the existing progress-saving consent is exactly what it was
  assert.match(model("IncompleteCheckout"), /\n\s+consentAt\s+DateTime\s/);
  for (const f of scalars("MarketingConsent")) assert.notEqual(f.name, "consentAt");
});

test("unsubscribe tokens are stored only as SHA-256 hashes", () => {
  const cols = scalars("EmailContact").map((f) => f.name);
  assert.ok(cols.includes("unsubscribeTokenHash"));
  assert.ok(!cols.some((c) => /token/i.test(c) && c !== "unsubscribeTokenHash"), "no plaintext token column");
  assert.match(table("EmailContact"), /"unsubscribeTokenHash" IS NULL OR "unsubscribeTokenHash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(model("EmailContact"), /unsubscribeTokenHash\s+String\?\s+@unique/);
});

test("foreign keys: history is RESTRICTed; purged or removable links are SET NULL", () => {
  const expected: Record<string, "RESTRICT" | "SET NULL"> = {
    EmailContact_userId_fkey: "SET NULL",
    MarketingConsent_contactId_fkey: "RESTRICT",
    EmailSuppression_contactId_fkey: "SET NULL",
    EmailCampaign_templateId_fkey: "SET NULL",
    EmailCampaignRecipient_campaignId_fkey: "RESTRICT",
    EmailCampaignRecipient_contactId_fkey: "RESTRICT",
    EmailCampaignRecipient_emailJobId_fkey: "SET NULL",
    EmailCampaignRecipient_consentId_fkey: "RESTRICT",
    RecoveryEmail_contactId_fkey: "RESTRICT",
    RecoveryEmail_incompleteCheckoutId_fkey: "SET NULL",
    RecoveryEmail_cartId_fkey: "SET NULL",
    RecoveryEmail_emailJobId_fkey: "SET NULL",
    RecoveryEmail_consentId_fkey: "RESTRICT",
  };
  const found = new Map([...sql.matchAll(/ADD CONSTRAINT "(\w+)" FOREIGN KEY \("(\w+)"\) REFERENCES "(\w+)"\("id"\) ON DELETE ([A-Z ]+?) ON UPDATE CASCADE;/g)].map((m) => [m[1], m[4]]));
  assert.deepEqual(Object.fromEntries(found), expected);
  // each FK column is indexed or unique so deletes/joins never scan
  for (const [name] of found) {
    const [, tbl, col] = name.match(/^(\w+?)_(\w+)_fkey$/)!;
    assert.match(sql, new RegExp(`INDEX "${tbl}_[\\w]*${col}[\\w]*" ON "${tbl}"\\([^)]*"${col}"`), `${name} has an index`);
  }
  // the matching schema onDelete values
  assert.equal((schema.match(/onDelete: Restrict/g) ?? []).length, [...found.values()].filter((v) => v === "RESTRICT").length + countOldRestrict());
});
function countOldRestrict() {
  // Restrict relations that existed before Prompt 07 (outside the new models) - computed so the check above only counts the new ones.
  const outside = schema.replace(/model (EmailContact|MarketingConsent|EmailSuppression|EmailTemplate|EmailCampaign|EmailCampaignRecipient|RecoveryEmail) \{[\s\S]*?\n\}/g, "");
  return (outside.match(/onDelete: Restrict/g) ?? []).length;
}

test("EmailJob is NOT altered: no DDL targets it, it is only referenced, and its columns are exactly the P7.3.3 set", () => {
  assert.doesNotMatch(sql, /(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX "\w+" ON) "EmailJob"/);
  const refs = [...sql.matchAll(/REFERENCES "EmailJob"\("id"\) ON DELETE (SET NULL)/g)];
  assert.equal(refs.length, 2, "campaign recipient and recovery e-mail point at it");
  assert.deepEqual(
    scalars("EmailJob").map((f) => f.name),
    ["id", "kind", "dedupeKey", "priority", "toEmail", "subject", "text", "html", "status", "attempts", "nextAttemptAt", "lockedAt", "lastAttemptAt", "sentAt", "errorCode", "errorMessage", "messageId", "createdAt", "updatedAt"],
  );
  // the only additions to the model are the two optional (non-column) back references
  assert.match(model("EmailJob"), /campaignRecipient EmailCampaignRecipient\?/);
  assert.match(model("EmailJob"), /recoveryEmail\s+RecoveryEmail\?/);
  const original = readFileSync(new URL("migrations/20261128000000_email_queue_p733/migration.sql", root), "utf8");
  assert.match(original, /CREATE TABLE "EmailJob"/);
});

test("existing models only gained inert back-relation lines (no new column on User, Cart, IncompleteCheckout)", () => {
  assert.match(model("User"), /emailContacts\s+EmailContact\[\]/);
  assert.match(model("Cart"), /recoveryEmails RecoveryEmail\[\]/);
  assert.match(model("IncompleteCheckout"), /recoveryEmails RecoveryEmail\[\]/);
  assert.deepEqual(scalars("Cart").map((f) => f.name), ["id", "userId", "guestToken", "createdAt", "updatedAt"]);
  assert.deepEqual(scalars("User").map((f) => f.name), ["id", "name", "email", "emailVerified", "passwordHash", "phone", "role", "isActive", "createdAt", "updatedAt"]);
});

test("template and campaign limits match the e-mail queue's EmailJob limits so anything stored can be queued", () => {
  const limits = readFileSync(new URL("../../src/lib/email/queue-policy.ts", import.meta.url), "utf8");
  assert.match(limits, /EMAIL_LIMITS = \{ subject: 200, text: 100_000, html: 200_000 \}/);
  for (const t of ["EmailTemplate", "EmailCampaign"]) {
    assert.match(table(t), /char_length\("subject"\) (BETWEEN 1 AND|<=) 200/);
    assert.match(table(t), /char_length\("textBody"\) (BETWEEN 1 AND|<=) 100000/);
    assert.match(table(t), /char_length\("htmlBody"\) <= 200000/);
  }
});

test("campaign state rules: SCHEDULED needs a time, COMPLETED needs a time, counts are non-negative and add up", () => {
  const t = table("EmailCampaign");
  assert.match(t, /"status" <> 'SCHEDULED' OR "scheduledAt" IS NOT NULL/);
  assert.match(t, /"status" <> 'COMPLETED' OR "completedAt" IS NOT NULL/);
  assert.match(t, /"sentCount" \+ "failedCount" \+ "skippedCount" <= "recipientCount"/);
  assert.match(t, /"status" "EmailCampaignStatus" NOT NULL DEFAULT 'DRAFT'/);
});

test("the migration documents its rollback and the rollback covers every table and type it creates", () => {
  assert.match(raw, /ROLLBACK/);
  for (const t of NEW_MODELS) assert.match(raw, new RegExp(`--   DROP TABLE "${t}";`));
  for (const e of NEW_ENUMS) assert.match(raw, new RegExp(`--   DROP TYPE "${e}";`));
  // tables are dropped before the tables they reference
  const order = [...raw.matchAll(/--   DROP TABLE "(\w+)";/g)].map((m) => m[1]);
  assert.ok(order.indexOf("RecoveryEmail") < order.indexOf("EmailContact"));
  assert.ok(order.indexOf("EmailCampaignRecipient") < order.indexOf("EmailCampaign"));
  assert.ok(order.indexOf("EmailCampaignRecipient") < order.indexOf("MarketingConsent"));
});

test("scope guard: no Pathao/RedX, courier or fraud reference in the new database design", () => {
  for (const text of [sql, ...NEW_MODELS.map((m) => model(m))]) assert.doesNotMatch(text, /pathao|redx|courier|fraud/i);
});
