import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findUnsafeHtml, normalizePagination, renderEmailTemplate, scanPlaceholders, SUPPORTED_TEMPLATE_VARIABLES, validateTemplateContent,
} from "@/lib/email/template-rules";
import {
  CAMPAIGN_STATUSES, CAMPAIGN_TRANSITIONS, SENDER_ONLY_STATUSES, SYSTEM_TRANSITIONS, canSystemTransitionCampaign, canTransitionCampaign, cleanSenderEmail, cleanSenderName, isCampaignEditable, validateScheduledAt,
} from "@/lib/email/campaign-rules";

const NOW = new Date("2026-11-25T10:00:00.000Z");

test("placeholders: supported names pass (with optional spaces); unsupported, malformed and triple-brace forms are reported", () => {
  assert.deepEqual(scanPlaceholders("Hi {{customerName}}, {{ email }} {{customerName}}").variables, ["customerName", "email"]);
  assert.equal(scanPlaceholders("{{customerName}}").problems.length, 0);
  for (const bad of ["{{ constructor }}", "{{ user.name }}", "{{#if x}}", "{{ 1+1 }}", "{{x}}", "{{}}", "{{ name", "name }}", "{{{customerName}}}"]) {
    assert.ok(scanPlaceholders(bad).problems.length > 0, bad);
  }
  assert.equal(scanPlaceholders("${customerName} <%= x %> {single}").problems.length, 0, "other syntaxes are inert text, never interpreted");
});

test("content validation mirrors the database limits and names the failing field", () => {
  const ok = validateTemplateContent({ subject: "Hello", textBody: "Body {{firstName}}", htmlBody: "<p>{{storeName}}</p>" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.variables, ["firstName", "storeName"]);
  const cases: [Record<string, unknown>, string, string][] = [
    [{ subject: "", textBody: "b" }, "subject", "required"],
    [{ subject: "x".repeat(201), textBody: "b" }, "subject", "too_long"],
    [{ subject: "a\r\nBcc: x@y.com", textBody: "b" }, "subject", "control_characters"],
    [{ subject: "s", textBody: "   " }, "textBody", "required"],
    [{ subject: "s", textBody: "x".repeat(100_001) }, "textBody", "too_long"],
    [{ subject: "s", textBody: "a\u0000b" }, "textBody", "control_characters"],
    [{ subject: "s", textBody: "b", htmlBody: "x".repeat(200_001) }, "htmlBody", "too_long"],
    [{ subject: "s", textBody: "b", htmlBody: 5 }, "htmlBody", "invalid_type"],
    [{ subject: "s {{secret}}", textBody: "b" }, "subject", "unsupported_variable"],
    [{ subject: "s", textBody: "{{ a.b }}" }, "textBody", "malformed_placeholder"],
    [{ subject: "s", textBody: "b", htmlBody: "<p>{{ x }}</p>" }, "htmlBody", "unsupported_variable"],
  ];
  for (const [input, field, code] of cases) {
    const r = validateTemplateContent(input as never);
    assert.ok(!r.ok, JSON.stringify(input).slice(0, 60));
    assert.ok(!r.ok && r.errors.some((e) => e.field === field && e.code === code), `${field}/${code}: ${JSON.stringify(!r.ok && r.errors)}`);
  }
  assert.ok(validateTemplateContent({ subject: "s", textBody: "line1\r\n\tline2" }).ok, "tab and line breaks are fine in a body");
});

test("unsafe HTML is refused, including obfuscated forms; ordinary markup passes", () => {
  for (const html of [
    "<script>alert(1)</script>", "<SCRIPT src=x>", "<iframe src=x></iframe>", "<object data=x>", "<embed src=x>", "<base href=x>",
    '<img src=x onerror="a()">', "<a onclick = 'x'>t</a>", '<a href="javascript:alert(1)">x</a>', '<a href=" JaVa\tScRiPt:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>', '<a href="&#x6A;avascript:alert(1)">x</a>', '<a href="vbscript:x">x</a>', '<a href="data:text/html;base64,AAA">x</a>',
  ]) assert.notEqual(findUnsafeHtml(html), null, html);
  for (const html of ['<p style="color:red">Hi <a href="https://shop.example.com/a?x=1">link</a></p>', '<img src="https://x.test/a.png" alt="on sale">', "<p>onclick = nothing</p>"]) {
    assert.equal(findUnsafeHtml(html), null, html);
  }
  const r = validateTemplateContent({ subject: "s", textBody: "b", htmlBody: "<script>x</script>" });
  assert.ok(!r.ok && r.errors[0].code === "unsafe_html");
});

test("rendering is a single safe pass: values are escaped, cleaned and never re-expanded; nothing is evaluated", () => {
  const out = renderEmailTemplate(
    { subject: "Hi {{ customerName }}", textBody: "Dear {{customerName}} <{{email}}>", htmlBody: "<p>{{customerName}}</p>" },
    { customerName: '<b>"Eve"</b>\r\nBcc: a@b.com', email: "{{customerName}}" },
  );
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.ok(!/[\r\n]/.test(out.subject), "no line break can reach the subject header");
  assert.equal(out.htmlBody, "<p>&lt;b&gt;&quot;Eve&quot;&lt;/b&gt; Bcc: a@b.com</p>");
  assert.ok(out.textBody.endsWith("<{{customerName}}>"), "a value that looks like a placeholder is left as text");
  assert.equal(renderEmailTemplate({ subject: "{{a}} {{firstName}}", textBody: "t" }, {}).ok, false, "unsupported variable is refused at render");
  assert.equal((renderEmailTemplate({ subject: "x{{firstName}}y", textBody: "t" }, {}) as { subject: string }).subject, "xy", "missing value = empty");
  assert.deepEqual([...SUPPORTED_TEMPLATE_VARIABLES].sort(), ["customerName", "email", "firstName", "storeName", "unsubscribeUrl"]);
});

test("pagination refuses bad numbers instead of clamping", () => {
  assert.deepEqual(normalizePagination({}), { ok: true, page: 1, pageSize: 20, skip: 0 });
  assert.deepEqual(normalizePagination({ page: 3, pageSize: 10 }), { ok: true, page: 3, pageSize: 10, skip: 20 });
  for (const bad of [{ page: 0 }, { page: 1.5 }, { page: "2" }, { pageSize: 101 }, { pageSize: -1 }]) assert.equal(normalizePagination(bad).ok, false, JSON.stringify(bad));
});

test("campaign lifecycle uses only the existing statuses; final statuses have no way out; only DRAFT is editable", () => {
  assert.deepEqual([...CAMPAIGN_STATUSES], ["DRAFT", "SCHEDULED", "SENDING", "COMPLETED", "CANCELLED", "FAILED"]);
  for (const f of ["COMPLETED", "CANCELLED", "FAILED"] as const) assert.deepEqual(CAMPAIGN_TRANSITIONS[f], []);
  assert.ok(canTransitionCampaign("DRAFT", "SCHEDULED") && canTransitionCampaign("SCHEDULED", "DRAFT") && canTransitionCampaign("SENDING", "COMPLETED"));
  assert.ok(!canTransitionCampaign("DRAFT", "SENDING") && !canTransitionCampaign("DRAFT", "COMPLETED") && !canTransitionCampaign("CANCELLED", "DRAFT"));
  assert.deepEqual(CAMPAIGN_STATUSES.filter(isCampaignEditable), ["DRAFT"]);
});

test("Prompt 12: the public lifecycle is unchanged; the dispatcher's own SCHEDULED -> FAILED is a separate, single-entry system table", () => {
  assert.deepEqual(CAMPAIGN_TRANSITIONS, { DRAFT: ["SCHEDULED", "CANCELLED"], SCHEDULED: ["DRAFT", "SENDING", "CANCELLED"], SENDING: ["COMPLETED", "FAILED", "CANCELLED"], COMPLETED: [], CANCELLED: [], FAILED: [] }, "the public table is exactly what P09 defined");
  assert.ok(!canTransitionCampaign("SCHEDULED", "FAILED"), "not a public transition");
  const pairs = CAMPAIGN_STATUSES.flatMap((from) => CAMPAIGN_STATUSES.map((to) => [from, to] as const));
  assert.deepEqual(pairs.filter(([f, t]) => canSystemTransitionCampaign(f, t)), [["SCHEDULED", "FAILED"]], "exactly one internal move among all 36");
  assert.ok(pairs.every(([f, t]) => !(canSystemTransitionCampaign(f, t) && canTransitionCampaign(f, t))), "the two tables never overlap: nothing public was widened");
  assert.ok(SENDER_ONLY_STATUSES.includes("FAILED"), "FAILED stays a sender-owned status");
  assert.deepEqual(Object.keys(SYSTEM_TRANSITIONS).sort(), [...CAMPAIGN_STATUSES].sort());
  for (const f of ["DRAFT", "SENDING", "COMPLETED", "CANCELLED", "FAILED"] as const) assert.deepEqual(SYSTEM_TRANSITIONS[f], [], `${f} has no internal move (a SENDING campaign is never closed by the dispatcher)`);
});

test("sender and schedule validation", () => {
  assert.ok(cleanSenderName("GiftPacific Team").ok && !cleanSenderName("Evil <a@b.com>").ok && !cleanSenderName("a\nb").ok);
  assert.deepEqual(cleanSenderEmail(" Shop@Example.COM "), { ok: true, value: "shop@example.com" });
  assert.deepEqual(cleanSenderEmail(""), { ok: true, value: null });
  assert.ok(!cleanSenderEmail("not an email").ok && !cleanSenderEmail("a@b.com, c@d.com").ok);
  assert.ok(validateScheduledAt("2026-12-01T09:00:00Z", NOW).ok);
  for (const bad of ["2026-11-25T09:00:00Z", "tomorrow", NaN, new Date("x"), "2028-01-01T00:00:00Z", null]) assert.equal(validateScheduledAt(bad, NOW).ok, false, String(bad));
});

test("the new rules modules are pure and server-side only", () => {
  for (const f of ["template-rules", "campaign-rules"]) {
    const src = readFileSync(new URL(`../../src/lib/email/${f}.ts`, import.meta.url), "utf8");
    assert.ok(!/prisma|server-only|fetch\(|process\.env|\beval\(|new Function/.test(src), `${f} must stay pure`);
  }
});
