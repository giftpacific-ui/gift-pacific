import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getPublishedTeam, adminSaveTeamMember } from "@/server/services/team.service";
import { adminSaveJob, listOpenJobs, getOpenJobBySlug, submitApplication, adminUpdateApplication } from "@/server/services/career.service";
import { getActiveBanners } from "@/server/services/product.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); });
const guest = <T,>(fn: () => Promise<T>) => runAs(null, fn);

test("about us: only PUBLISHED members, Management and Staff separate, ordered by display order, public fields only", () => guest(async () => {
  db.insert("teamMember", { id: "m1", section: "MANAGEMENT", name: "Founder", designation: "CEO", sortOrder: 2, isPublished: true, bio: "Hi", imageUrl: "https://res.cloudinary.com/x/a.jpg", imageCloudinaryPublicId: "secret-id" });
  db.insert("teamMember", { id: "m2", section: "MANAGEMENT", name: "Partner", designation: "COO", sortOrder: 1, isPublished: true });
  db.insert("teamMember", { id: "m3", section: "STAFF", name: "Packer", designation: "Packing", sortOrder: 0, isPublished: true });
  db.insert("teamMember", { id: "m4", section: "STAFF", name: "Draft Person", designation: "Hidden", isPublished: false });
  const team = await getPublishedTeam();
  assert.deepEqual(team.management.map((m) => m.name), ["Partner", "Founder"]);
  assert.deepEqual(team.staff.map((m) => m.name), ["Packer"]);
  assert.deepEqual(Object.keys(team.management[1]).sort(), ["bio", "designation", "id", "imageUrl", "name"]);
  assert.ok(!JSON.stringify(team).includes("secret-id") && !JSON.stringify(team).includes("Draft Person"));
}));

test("team admin validation: required fields, https-only image, bounded lengths", () => guest(async () => {
  const ok = { section: "STAFF" as const, name: "A", designation: "B", sortOrder: 0, isPublished: true };
  await adminSaveTeamMember(null, ok);
  await assert.rejects(adminSaveTeamMember(null, { ...ok, name: " " }), /Name is required/);
  await assert.rejects(adminSaveTeamMember(null, { ...ok, imageUrl: "javascript:alert(1)" }), /valid https/);
  await assert.rejects(adminSaveTeamMember(null, { ...ok, bio: "x".repeat(1501) }));
  assert.equal(db.rows("teamMember").length, 1);
}));

const job = (over = {}) => ({ title: "Packing Associate", description: "Pack orders carefully and on time.", status: "PUBLISHED" as const, ...over });

test("career: only published, open jobs are public; applicant data never appears in public reads", () => guest(async () => {
  const open = await adminSaveJob(null, job());
  await adminSaveJob(null, job({ title: "Draft role", status: "DRAFT" }));
  await adminSaveJob(null, job({ title: "Closed role", status: "CLOSED" }));
  await adminSaveJob(null, job({ title: "Expired role", closesAt: "2020-01-01" }));
  const jobs = await listOpenJobs();
  assert.deepEqual(jobs.map((j) => j.title), ["Packing Associate"]);
  assert.equal(open.slug, "packing-associate");
  assert.equal(await getOpenJobBySlug("draft-role"), null);
  assert.equal(await getOpenJobBySlug("closed-role"), null);
  await submitApplication("packing-associate", { name: "Jo Doe", email: "JO@x.com", consent: true, coverNote: "private words" });
  const publicJson = JSON.stringify([await listOpenJobs(), await getOpenJobBySlug("packing-associate")]);
  assert.ok(!publicJson.includes("jo@x.com") && !publicJson.includes("private words") && !publicJson.includes("Jo Doe"));
}));

test("career: slugs stay unique", () => guest(async () => {
  const a = await adminSaveJob(null, job());
  const b = await adminSaveJob(null, job());
  assert.notEqual(a.slug, b.slug);
}));

test("applications: consent required, honeypot, email format, duplicates, closed jobs, answers validated against the questions", () => guest(async () => {
  const j = await adminSaveJob(null, job());
  db.insert("jobQuestion", { id: "q1", jobPostId: j.id, label: "Can you work weekends?", kind: "YES_NO", isRequired: true, sortOrder: 0 });
  db.insert("jobQuestion", { id: "q2", jobPostId: j.id, label: "Shift", kind: "SELECT", options: ["Morning", "Evening"], isRequired: false, sortOrder: 1 });
  const base = { name: "Jo Doe", email: "jo@x.com", consent: true, answers: { q1: "Yes" } };
  const fails = async (over: object, re: RegExp) => { const r = await submitApplication("packing-associate", { ...base, ...over }); assert.equal(r.success, false); assert.match((r as { message: string }).message, re); };
  await fails({ consent: false }, /agree/i);
  await fails({ email: "nope" }, /email/i);
  await fails({ website: "http://spam" }, /./);                       // honeypot filled
  await fails({ answers: {} }, /Can you work weekends/);             // required answer
  await fails({ answers: { q1: "Maybe" } }, /Yes or No/);
  await fails({ answers: { q1: "Yes", q2: "Midnight" } }, /Choose one/);
  await fails({ portfolioUrl: "javascript:alert(1)" }, /https/);
  assert.equal(db.rows("jobApplication").length, 0);
  const ok = await submitApplication("packing-associate", { ...base, answers: { q1: "Yes", q2: "Morning" } });
  assert.equal(ok.success, true);
  const [app] = db.rows("jobApplication");
  assert.equal(app.email, "jo@x.com");                                // normalised
  assert.ok(app.consentAt instanceof Date);
  assert.deepEqual(db.rows("jobApplicationAnswer").map((a) => [a.questionLabel, a.value]), [["Can you work weekends?", "Yes"], ["Shift", "Morning"]]);
  await fails({ email: "JO@x.com" }, /already applied/);             // duplicate, case-insensitive
  await db.jobPost.update({ where: { id: j.id }, data: { status: "CLOSED" } });
  const closed = await submitApplication("packing-associate", { ...base, email: "other@x.com" });
  assert.equal(closed.success, false);
}));

test("application status workflow: valid statuses only; private note is capped", () => guest(async () => {
  const j = await adminSaveJob(null, job());
  await submitApplication(j.slug, { name: "Jo Doe", email: "jo@x.com", consent: true });
  const id = db.rows("jobApplication")[0].id;
  await adminUpdateApplication(id, { status: "SHORTLISTED", adminNote: "  strong  " });
  assert.equal(db.get("jobApplication", id).status, "SHORTLISTED");
  assert.equal(db.get("jobApplication", id).adminNote, "strong");
  await assert.rejects(adminUpdateApplication(id, { status: "HIRED-ISH" }), /Invalid status/);
  await assert.rejects(adminUpdateApplication("missing", { status: "NEW" }), /not found/);
}));

test("homepage banners come from the database: placement, active flag, date window and display order", () => guest(async () => {
  const day = 86_400_000;
  const b = (id: string, over: object) => db.insert("banner", { id, title: id, imageUrl: "https://x/i.jpg", placement: "HERO", isActive: true, sortOrder: 0, startsAt: null, endsAt: null, ...over });
  b("second", { sortOrder: 2 });
  b("first", { sortOrder: 1 });
  b("inactive", { isActive: false });
  b("future", { startsAt: new Date(Date.now() + day) });
  b("expired", { endsAt: new Date(Date.now() - day) });
  b("live-window", { startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day), sortOrder: 3 });
  b("other-placement", { placement: "MID_PAGE" });
  assert.deepEqual((await getActiveBanners("HERO")).map((x) => x.id), ["first", "second", "live-window"]);
  assert.deepEqual((await getActiveBanners("MID_PAGE")).map((x) => x.id), ["other-placement"]);
  assert.deepEqual(await getActiveBanners("POPUP"), []);
}));
