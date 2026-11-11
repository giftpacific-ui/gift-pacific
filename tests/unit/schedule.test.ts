import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinWindow, parseScheduleDate, parseScheduleWindow } from "@/lib/schedule";
import { validateCampaignInput } from "@/lib/campaign-rules";

test("date-only values use Bangladesh time: start = 00:00, end = 23:59:59.999 (inclusive)", () => {
  const s = parseScheduleDate("2026-12-25", "start");
  const e = parseScheduleDate("2026-12-25", "end");
  assert.ok(s.ok && e.ok);
  assert.equal(s.ok && s.value!.toISOString(), "2026-12-24T18:00:00.000Z");
  assert.equal(e.ok && e.value!.toISOString(), "2026-12-25T17:59:59.999Z");
  // a promotion ending "Dec 25" is still running at 23:00 Dhaka time on Dec 25
  const endsAt = (e as { value: Date }).value;
  assert.equal(isWithinWindow(new Date("2026-12-25T17:00:00Z"), null, endsAt), true);
  assert.equal(isWithinWindow(new Date("2026-12-25T18:00:01Z"), null, endsAt), false);
});

test("blank, invalid and impossible dates", () => {
  assert.deepEqual(parseScheduleDate("", "start"), { ok: true, value: null });
  assert.deepEqual(parseScheduleDate(undefined, "end"), { ok: true, value: null });
  for (const bad of ["garbage", "2026-02-30", "2026-13-01", "31/12/2026"]) assert.equal(parseScheduleDate(bad, "start").ok, false, bad);
  assert.equal(parseScheduleDate("2026-06-01T10:00:00Z", "start").ok, true); // full timestamps pass through
});

test("window ordering is validated", () => {
  assert.equal(parseScheduleWindow("2026-05-01", "2026-04-01").ok, false);
  assert.equal(parseScheduleWindow("2026-05-01", "2026-05-01").ok, true); // same calendar day = a one-day window
  assert.equal(parseScheduleWindow("2026-05-01", "").ok, true);
  assert.equal(parseScheduleWindow("x", "").ok, false);
});

test("campaign input rules", () => {
  const ok = { name: "Eid Sale", slug: "eid-sale" };
  assert.equal(validateCampaignInput(ok), null);
  for (const bad of [{ ...ok, name: "A" }, { ...ok, slug: "Eid Sale" }, { ...ok, slug: "-x" }, { ...ok, slug: "x".repeat(61) }, { ...ok, description: "d".repeat(501) }, { ...ok, image: "javascript:alert(1)" }]) {
    assert.notEqual(validateCampaignInput(bad), null, JSON.stringify(bad));
  }
  assert.equal(validateCampaignInput({ ...ok, image: "https://res.cloudinary.com/x.png" }), null);
});
