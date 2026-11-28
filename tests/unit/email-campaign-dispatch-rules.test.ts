import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assessDispatchState, buildCampaignMessage, CAMPAIGN_JOB_KIND, CAMPAIGN_SEND_BLOCK, firstNameOf, isCampaignFinished, safeErrorCode,
} from "@/lib/email/campaign-dispatch-rules";
import { emailDedupeKey } from "@/lib/email/queue-policy";
import { validateUnsubscribeUrl } from "@/lib/email/unsubscribe";

const NOW = new Date("2026-11-25T10:00:00.000Z");
const PAST = new Date("2026-11-25T09:00:00.000Z");
const FUTURE = new Date("2026-11-25T11:00:00.000Z");
// Prompt 11: the builder needs a VALIDATED unsubscribe URL (only validateUnsubscribeUrl can make one).
const UENV = { NEXT_PUBLIC_APP_URL: "https://shop.example.com", NODE_ENV: "production" };
const checked = validateUnsubscribeUrl("https://shop.example.com/api/email/unsubscribe/" + "A".repeat(43), UENV);
if (!checked.ok) throw new Error("test URL must validate");
const U = checked.url;

test("dispatchable states: a due SCHEDULED campaign starts, a SENDING one resumes, nothing else is dispatchable", () => {
  assert.deepEqual(assessDispatchState("SCHEDULED", PAST, NOW), { ok: true, resumed: false });
  assert.deepEqual(assessDispatchState("SCHEDULED", NOW, NOW), { ok: true, resumed: false }, "exactly due counts as due");
  assert.deepEqual(assessDispatchState("SENDING", null, NOW), { ok: true, resumed: true });
  const early = assessDispatchState("SCHEDULED", FUTURE, NOW);
  assert.ok(!early.ok && early.reason === "not_due");
  for (const bad of [null, undefined, new Date("x")]) assert.ok(!assessDispatchState("SCHEDULED", bad as never, NOW).ok);
  for (const status of ["DRAFT", "COMPLETED", "CANCELLED", "FAILED", "PAUSED", undefined, 7]) {
    const r = assessDispatchState(status, PAST, NOW);
    assert.ok(!r.ok && r.reason === "invalid_status", String(status));
  }
});

test("the campaign message: personalised from fixed values only, valid for the queue, keyed by campaign + recipient (never the address)", () => {
  const contact = { id: "c1", email: "eve@example.com", name: "Eve Adams" };
  const r = buildCampaignMessage("camp1", "rec1", contact, { subject: "Hi {{firstName}}", textBody: "Dear {{customerName}} at {{storeName}} <{{email}}> {{unsubscribeUrl}}", htmlBody: "<p>{{customerName}} <a href=\"{{unsubscribeUrl}}\">u</a></p>" }, "Gift Pacific", U);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual([r.input.kind, r.input.to, r.input.subject, r.input.text, r.input.html], [CAMPAIGN_JOB_KIND, "eve@example.com", "Hi Eve", `Dear Eve Adams at Gift Pacific <eve@example.com> ${U}`, `<p>Eve Adams <a href="${U}">u</a></p>`]);
  assert.deepEqual(r.input.dedupeParts, ["camp1", "rec1"]);
  assert.equal(r.dedupeKey, emailDedupeKey("campaign", ["camp1", "rec1"]));
  assert.ok(!r.dedupeKey.includes("eve"), "no address in the key");
  const again = buildCampaignMessage("camp1", "rec1", contact, { subject: "x", textBody: "y {{unsubscribeUrl}}", htmlBody: null }, "S", U);
  assert.ok(again.ok && again.dedupeKey === r.dedupeKey, "the key does not depend on the content");
  const other = buildCampaignMessage("camp1", "rec2", contact, { subject: "x", textBody: "y {{unsubscribeUrl}}", htmlBody: null }, "S", U);
  assert.ok(other.ok && other.dedupeKey !== r.dedupeKey);
});

test("a hostile name cannot inject headers or markup; an unusable personalised subject is reported, not queued", () => {
  const evil = { id: "c", email: "a@example.com", name: '<img src=x onerror=alert(1)>\r\nBcc: z@z.com' };
  const r = buildCampaignMessage("k", "r", evil, { subject: "Hello {{customerName}}", textBody: "t {{customerName}} {{unsubscribeUrl}}", htmlBody: "<p>{{customerName}} {{unsubscribeUrl}}</p>" }, "S", U);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(!/[\r\n]/.test(r.input.subject));
  assert.ok(!r.input.html!.includes("<img"), "markup in a value is escaped");
  const long = buildCampaignMessage("k", "r", { id: "c", email: "a@example.com", name: "n".repeat(300) }, { subject: "{{customerName}}", textBody: "t {{unsubscribeUrl}}", htmlBody: null }, "S", U);
  assert.ok(!long.ok && long.errors[0].code === "invalid_message");
  assert.ok(!buildCampaignMessage("k", "r", { id: "c", email: "not-an-email", name: null }, { subject: "s", textBody: "t {{unsubscribeUrl}}", htmlBody: null }, "S", U).ok);
  assert.ok(!buildCampaignMessage("k", "r", { id: "c", email: "a@example.com", name: null }, { subject: "{{nope}}", textBody: "t {{unsubscribeUrl}}", htmlBody: null }, "S", U).ok);
});

test("first name and error-code helpers", () => {
  assert.deepEqual([firstNameOf("  Eve   Adams "), firstNameOf(""), firstNameOf(null), firstNameOf(undefined)], ["Eve", "", "", ""]);
  assert.deepEqual([safeErrorCode("recipient_rejected"), safeErrorCode("Server said: no"), safeErrorCode(null), safeErrorCode("x".repeat(41)), safeErrorCode("a\nb")], ["recipient_rejected", null, null, null, null]);
  assert.deepEqual(Object.values(CAMPAIGN_SEND_BLOCK).sort(), ["campaign_not_active", "invalid_message", "job_missing", "recipient_ineligible", "recipient_missing", "recipient_not_queued", "unsubscribe_link_missing", "unsubscribe_unavailable"]);
  for (const code of Object.values(CAMPAIGN_SEND_BLOCK)) assert.equal(safeErrorCode(code), code, "every block code is a valid fixed code");
});

test("a campaign is finished only when nothing is waiting or in flight: queued is not delivered", () => {
  const c = (over: Record<string, number>) => ({ total: 4, pending: 0, queued: 0, sent: 4, failed: 0, skipped: 0, ...over });
  assert.ok(isCampaignFinished(c({})));
  assert.ok(isCampaignFinished(c({ sent: 1, failed: 1, skipped: 2 })));
  assert.ok(!isCampaignFinished(c({ queued: 4, sent: 0 })), "all jobs queued is NOT finished");
  assert.ok(!isCampaignFinished(c({ pending: 1, sent: 3 })));
  assert.ok(!isCampaignFinished(c({ total: 0, sent: 0 })));
});

test("the dispatch rules module is pure", () => {
  const src = readFileSync(new URL("../../src/lib/email/campaign-dispatch-rules.ts", import.meta.url), "utf8");
  assert.ok(!/prisma|server-only|fetch\(|process\.env|\beval\(|new Function|sendSmtpMail|nodemailer/.test(src));
});
