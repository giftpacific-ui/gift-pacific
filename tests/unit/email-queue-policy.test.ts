import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EMAIL_JOB_MAX_ATTEMPTS, EMAIL_QUEUE_DEFAULTS, classifyEmailFailure, emailDedupeKey, emailSendBudget, nextEmailRetryDelayMs, parseEmailQueueLimits, validateEmailJobInput,
} from "@/lib/email/queue-policy";
import type { SmtpFailureCode } from "@/lib/email/smtp";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const ok = { kind: "order-confirmation", dedupeParts: ["GP-1001"], to: "buyer@example.com", subject: "Your order", text: "Thanks!" };

test("retry delays grow, are bounded, and stop after the maximum number of attempts", () => {
  const delays = [1, 2, 3, 4].map((n) => nextEmailRetryDelayMs(n));
  assert.ok(delays.every((d): d is number => typeof d === "number" && d >= 60_000));
  assert.deepEqual([...delays].sort((a, b) => (a as number) - (b as number)), delays); // non-decreasing
  assert.equal(nextEmailRetryDelayMs(EMAIL_JOB_MAX_ATTEMPTS), null);
  assert.equal(nextEmailRetryDelayMs(EMAIL_JOB_MAX_ATTEMPTS + 3), null);
  assert.equal(EMAIL_JOB_MAX_ATTEMPTS, 5);
});

test("failure classes: refused recipient is permanent, broken SMTP setup is systemic, everything else is temporary", () => {
  const codes: SmtpFailureCode[] = ["not_configured", "invalid_config", "auth_failed", "tls_failed", "dns_failed", "dependency_missing", "timeout", "connection_failed", "recipient_rejected", "send_rejected", "unknown"];
  const got = Object.fromEntries(codes.map((c) => [c, classifyEmailFailure(c)]));
  assert.deepEqual(got, {
    not_configured: "systemic", invalid_config: "systemic", auth_failed: "systemic", tls_failed: "systemic", dependency_missing: "systemic",
    recipient_rejected: "permanent",
    dns_failed: "temporary", timeout: "temporary", connection_failed: "temporary", send_rejected: "temporary", unknown: "temporary",
  });
});

test("sending limits: defaults, valid overrides, and unusable values fall back", () => {
  assert.deepEqual(parseEmailQueueLimits({}), EMAIL_QUEUE_DEFAULTS);
  assert.deepEqual(parseEmailQueueLimits({ EMAIL_QUEUE_BATCH_SIZE: "5", EMAIL_QUEUE_MAX_PER_HOUR: "50", EMAIL_QUEUE_MAX_PER_DAY: "200" }), { batchSize: 5, perHour: 50, perDay: 200 });
  for (const bad of ["", "abc", "-3", "0", "1.5", "99999999", " 7x", "1e3"]) {
    assert.deepEqual(parseEmailQueueLimits({ EMAIL_QUEUE_BATCH_SIZE: bad, EMAIL_QUEUE_MAX_PER_HOUR: bad, EMAIL_QUEUE_MAX_PER_DAY: bad }), EMAIL_QUEUE_DEFAULTS, `value ${JSON.stringify(bad)}`);
  }
  assert.ok(EMAIL_QUEUE_DEFAULTS.perDay < 500, "stays under Gmail's ~500/day");
});

test("send budget is the smallest of batch / hour left / day left and never negative", () => {
  const l = { batchSize: 20, perHour: 100, perDay: 400 };
  assert.equal(emailSendBudget(l, 0, 0), 20);
  assert.equal(emailSendBudget(l, 95, 95), 5);
  assert.equal(emailSendBudget(l, 10, 395), 5);
  assert.equal(emailSendBudget(l, 100, 100), 0);
  assert.equal(emailSendBudget(l, 500, 900), 0);
});

test("dedupe key: stable, case/space-insensitive, kind-scoped, hides the address, order of parts matters", () => {
  const a = emailDedupeKey("campaign", ["Camp-1", "Buyer@Example.com"]);
  assert.equal(a, emailDedupeKey("campaign", [" camp-1 ", "buyer@example.com "]));
  assert.notEqual(a, emailDedupeKey("campaign", ["camp-2", "buyer@example.com"]));
  assert.notEqual(a, emailDedupeKey("campaign", ["buyer@example.com", "camp-1"]));
  assert.notEqual(emailDedupeKey("a", ["x"]), emailDedupeKey("b", ["x"]));
  assert.notEqual(emailDedupeKey("k", ["ab", "c"]), emailDedupeKey("k", ["a", "bc"]), "part boundaries are unambiguous");
  assert.match(a as string, /^campaign:[0-9a-f]{40}$/);
  assert.ok(!(a as string).includes("example"));
});

test("dedupe key rejects an unusable kind or parts", () => {
  for (const [kind, parts] of [["Bad Kind", ["x"]], ["", ["x"]], ["k", []], ["k", [""]], ["k", ["  "]], ["k", ["x".repeat(301)]], ["k", Array(9).fill("x")], ["../x", ["x"]]] as [string, string[]][]) {
    assert.equal(emailDedupeKey(kind, parts), null, `${kind}/${parts.length}`);
  }
});

test("job input: a valid job is normalised; every invalid shape is refused with a fixed message", () => {
  const good = validateEmailJobInput({ ...ok, to: "  Buyer@Example.com ", subject: "  Your order  ", html: "" });
  assert.ok(good.ok);
  if (good.ok) { assert.equal(good.job.toEmail, "Buyer@Example.com"); assert.equal(good.job.subject, "Your order"); assert.equal(good.job.html, null); }
  const bads: Record<string, unknown>[] = [
    { to: "not-an-address" }, { to: "a@x.com, b@x.com" }, { to: "a@x.com\r\nBcc: evil@x.com" }, { to: "" },
    { subject: "" }, { subject: "Hi\r\nBcc: evil@x.com" }, { subject: "x".repeat(201) },
    { text: "" }, { text: "   " }, { text: "x".repeat(100_001) }, { html: "x".repeat(200_001) },
    { kind: "BAD" }, { dedupeParts: [] },
  ];
  for (const over of bads) {
    const r = validateEmailJobInput({ ...ok, ...over } as never);
    assert.equal(r.ok, false, JSON.stringify(over).slice(0, 60));
    if (!r.ok) assert.doesNotMatch(r.message, /evil|buyer@/);
  }
});

test("architecture: the queue adds no Redis/queue dependency, and only lib/email/smtp.ts touches nodemailer", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(deps.filter((d) => /redis|bull|bee-queue|agenda|kue|pg-boss|ioredis/i.test(d)), []);
  const service = read("src/server/services/email-queue.service.ts");
  assert.ok(!/from\s+["']nodemailer["']|import\(["']nodemailer["']\)/.test(service));
  assert.match(service, /sendSmtpMail/);
  assert.ok(!/console\.(log|error|warn)\(/.test(service), "logging goes through the safe logger helpers");
  assert.match(read("src/lib/email/queue-policy.ts"), /^\/\*\*[\s\S]*PURE/m);
  assert.ok(!/prisma/.test(read("src/lib/email/queue-policy.ts").replace(/\/\*[\s\S]*?\*\//g, "")), "the policy module has no database access");
});
