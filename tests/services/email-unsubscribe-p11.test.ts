/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 11: stable unsubscribe tokens, the public unsubscribe route, campaign dispatch protection and List-Unsubscribe headers, on the in-memory
 * database with the REAL services (P07-P10 code unchanged except where Prompt 11 says so). The in-memory database proves service logic only; the
 * PostgreSQL-level guarantees are in tests/integration/email-unsubscribe.postgres.test.ts (skipped without TEST_DATABASE_URL).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, optedIn, scheduledCampaign, SMTP_ENV, T0, UNSUB_BASE, UNSUB_SECRET, withUnsubEnv, type Fixture } from "../setup/campaign-dispatch-fixture";
import { GET, POST } from "@/app/api/email/unsubscribe/[token]/route";
import { dispatchEmailCampaign } from "@/server/services/email-campaign-dispatch.service";
import { deliverEmailJob, processEmailQueue, enqueueEmail } from "@/server/services/email-queue.service";
import { ensureContactUnsubscribeLink, getContactUnsubscribeLink, issueStableUnsubscribeToken, resolveUnsubscribeToken, unsubscribeByStableToken } from "@/server/services/email-unsubscribe.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { deriveUnsubscribeToken, readUnsubscribeConfig } from "@/lib/email/unsubscribe";
import { hashUnsubscribeToken } from "@/lib/email/marketing";
import { UNSUBSCRIBE_ROUTE_PREFIX } from "@/lib/email/unsubscribe-path";
import { sendSmtpMail } from "@/lib/email/smtp";
import { buildCampaignMessage } from "@/lib/email/campaign-dispatch-rules";
import { EMAIL_INTERNAL_RETRY_MS, EMAIL_JOB_MAX_ATTEMPTS } from "@/lib/email/queue-policy";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => { db = freshDb(); smtp = makeSmtp(); discardAfter(); logs = captureLogs(); });
afterEach(() => logs.restore());

const D = () => db as never;
const go = (id: string, over: Record<string, unknown> = {}) => dispatchEmailCampaign(id, { db: D(), now: NOW, ...over }) as Promise<any>;
const run = (over: Record<string, unknown> = {}) => processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW, ...over });
const jobs = () => db.rows("emailJob");
const E = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}@example.com`);
const contactOf = (email: string) => db.rows("emailContact").find((c) => c.email === email)!;
const tokenOf = (email: string) => deriveUnsubscribeToken(UNSUB_SECRET, contactOf(email).id)!;
const urlOf = (email: string) => `${UNSUB_BASE}${UNSUBSCRIBE_ROUTE_PREFIX}${tokenOf(email)}`;
const jobFor = (f: Fixture, email: string) => jobs().find((j) => j.id === f.recipients().find((r) => r.contactId === contactOf(email).id)!.emailJobId)!;
const recipientFor = (f: Fixture, email: string) => f.recipients().find((r) => r.contactId === contactOf(email).id)!;
const stateOf = (email: string) => JSON.stringify([db.rows("marketingConsent").filter((c) => c.contactId === contactOf(email).id), db.rows("emailSuppression").filter((s) => s.email === email)]);
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const FORM = "application/x-www-form-urlencoded";
const ONE_CLICK = "List-Unsubscribe=One-Click";
const get = (token: string, headers: Record<string, string> = {}, method = "GET") => GET(new Request(`${UNSUB_BASE}${UNSUBSCRIBE_ROUTE_PREFIX}${token}`, { method, headers }), ctx(token));
const post = (token: string, body: string | null = ONE_CLICK, type: string | null = FORM) =>
  POST(new Request(`${UNSUB_BASE}${UNSUBSCRIBE_ROUTE_PREFIX}${token}`, { method: "POST", headers: type ? { "content-type": type } : {}, ...(body === null ? {} : { body }) }), ctx(token));

/** A dispatched campaign for `n` opted-in contacts, so every contact already holds its stable link hash. */
async function dispatched(n = 3, over: Record<string, unknown> = {}) {
  const f = await scheduledCampaign(db, E(n), over as never);
  const r = await go(f.campaignId);
  assert.ok(r.ok, JSON.stringify(r));
  return f;
}

// ===================================================================================================================== token behaviour

test("TOKEN: one stable link per contact across several campaigns; sending another campaign never changes or invalidates an earlier link", async () => {
  const f1 = await dispatched(3, { name: "First" });
  const firstUrls = Object.fromEntries(E(3).map((e) => [e, jobFor(f1, e).text.match(/Unsubscribe: (\S+)$/)![1]]));
  const hashesAfterFirst = E(3).map((e) => contactOf(e).unsubscribeTokenHash);
  assert.equal(new Set(Object.values(firstUrls)).size, 3, "every recipient has their own link");
  for (const e of E(3)) assert.equal(firstUrls[e], urlOf(e));

  const f2 = await scheduledCampaign(db, E(3), { reuse: true, name: "Second" });
  const r2 = await go(f2.campaignId);
  assert.ok(r2.ok, JSON.stringify(r2));
  for (const e of E(3)) {
    assert.equal(jobFor(f2, e).text.match(/Unsubscribe: (\S+)$/)![1], firstUrls[e], "the SAME link in the second campaign");
    assert.equal(jobFor(f2, e).html.includes(firstUrls[e]), true);
  }
  assert.deepEqual(E(3).map((e) => contactOf(e).unsubscribeTokenHash), hashesAfterFirst, "the stored hash did not change");
  for (const e of E(3)) assert.deepEqual(await resolveUnsubscribeToken(tokenOf(e), { db: D() }), { ok: true, contactId: contactOf(e).id, email: e }, "the first campaign's link still resolves after the second");
});

test("TOKEN: repeated rendering and repeated link creation give the same token and write nothing the second time", async () => {
  const f = await dispatched(1);
  const c = contactOf(E(1)[0]);
  const cfg = readUnsubscribeConfig(process.env);
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  const writes: unknown[] = [];
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailContact") { const um = d.updateMany.bind(d); d.updateMany = async (a: any) => { writes.push(a); return um(a); }; } return d; };
  const urls = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const r = await ensureContactUnsubscribeLink(D(), contactOf(E(1)[0]) as never, cfg);
    assert.ok(r.ok);
    if (r.ok) urls.add(r.url);
    const viaId = await getContactUnsubscribeLink(c.id, { db: D() });
    assert.ok(viaId.ok);
    if (viaId.ok) urls.add(viaId.url);
  }
  delete (db as any).delegate;
  assert.equal(urls.size, 1);
  assert.equal(writes.length, 0, "the hash was already right: no write");
  assert.equal([...urls][0], urlOf(E(1)[0]));
  assert.ok(f.recipients().length === 1);
});

test("TOKEN: invalid, malformed and forged tokens are rejected, and nothing changes", async () => {
  await dispatched(2);
  const real = tokenOf(E(2)[0]);
  const flipped = (real[0] === "A" ? "B" : "A") + real.slice(1);
  const otherSecret = deriveUnsubscribeToken(UNSUB_SECRET + "-another", contactOf(E(2)[0]).id)!;
  const before = JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression"), db.rows("emailContact")]);
  for (const bad of ["", "short", real + "x", real.slice(1), `${real.slice(0, 42)}=`, "A".repeat(43), flipped, otherSecret, "../etc/passwd", null, undefined, 7, {}]) {
    const r = await unsubscribeByStableToken(bad, { db: D(), now: NOW });
    assert.ok(!r.ok, String(bad));
    assert.ok(["invalid_token", "unknown_token"].includes((r as any).reason), `${String(bad)} -> ${(r as any).reason}`);
  }
  assert.equal(JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression"), db.rows("emailContact")]), before);
});

test("TOKEN: a token can only ever act on its own contact (also when stored data is corrupted)", async () => {
  await dispatched(2);
  const [a, b] = E(2);
  const bBefore = stateOf(b);
  assert.deepEqual(await unsubscribeByStableToken(tokenOf(a), { db: D(), now: NOW }), { ok: true, action: "created", consentClosed: true });
  assert.equal(stateOf(b), bBefore, "the other contact is completely untouched");
  assert.deepEqual(await getMarketingEligibility(b, { db: D(), now: NOW }), { eligible: true, consentId: db.rows("marketingConsent").find((c) => c.contactId === contactOf(b).id)!.id });

  // Corruption: contact A's row holds the hash of B's token. B's token finds A by hash, but is not A's token -> refused, nobody is unsubscribed.
  await (db as any).emailContact.update({ where: { id: contactOf(b).id }, data: { unsubscribeTokenHash: null } });
  await (db as any).emailContact.update({ where: { id: contactOf(a).id }, data: { unsubscribeTokenHash: hashUnsubscribeToken(tokenOf(b)) } });
  const forged = await unsubscribeByStableToken(tokenOf(b), { db: D(), now: NOW });
  assert.deepEqual(forged, { ok: false, reason: "unknown_token" });
  assert.equal(stateOf(b), bBefore, "B is still subscribed: the mismatched hash did not unsubscribe anyone");
});

test("TOKEN: a missing, weak or shared secret fails safely: nothing is verified, issued or written", async () => {
  await dispatched(1);
  const token = tokenOf(E(1)[0]);
  const before = JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression"), db.rows("emailContact")]);
  for (const env of [{}, { EMAIL_UNSUBSCRIBE_SECRET: "short" }, { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, AUTH_SECRET: UNSUB_SECRET }]) {
    assert.deepEqual(await resolveUnsubscribeToken(token, { db: D(), env }), { ok: false, reason: "secret_unavailable" });
    assert.deepEqual(await unsubscribeByStableToken(token, { db: D(), env }), { ok: false, reason: "secret_unavailable" });
    assert.deepEqual(await issueStableUnsubscribeToken(contactOf(E(1)[0]).id, { db: D(), env }), { ok: false, reason: "secret_unavailable" });
    assert.deepEqual(await getContactUnsubscribeLink(contactOf(E(1)[0]).id, { db: D(), env: { ...env, NEXT_PUBLIC_APP_URL: UNSUB_BASE } }), { ok: false, reason: "config_unavailable" });
  }
  assert.equal(JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression"), db.rows("emailContact")]), before);
});

test("TOKEN: plaintext tokens are never persisted: only SHA-256 hashes are stored, and no table keeps a token once the e-mail is sent", async () => {
  const f = await dispatched(3);
  await run();
  await post(tokenOf(E(3)[1])); // one recipient unsubscribes afterwards
  const everything = JSON.stringify(["emailContact", "marketingConsent", "emailSuppression", "emailCampaign", "emailCampaignRecipient", "emailTemplate", "emailJob"].map((t) => db.rows(t)));
  for (const e of E(3)) {
    assert.ok(!everything.includes(tokenOf(e)), "no token in any table (queued bodies are cleared once sent)");
    assert.equal(contactOf(e).unsubscribeTokenHash, hashUnsubscribeToken(tokenOf(e)));
    assert.match(contactOf(e).unsubscribeTokenHash, /^[0-9a-f]{64}$/);
  }
  assert.ok(f.recipients().every((r) => r.status === "SENT" || r.status === "SKIPPED" || r.status === "FAILED"));
});

// ======================================================================================================================== public route

test("ROUTE GET: validates the token and shows a confirmation page, but does NOT unsubscribe", async () => {
  await dispatched(2);
  const [a, b] = E(2);
  const before = JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression")]);
  const res = await get(tokenOf(a));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<form method="post"/);
  assert.match(html, /name="List-Unsubscribe" value="One-Click"/);
  assert.ok(html.includes(`action="${UNSUBSCRIBE_ROUTE_PREFIX}${tokenOf(a)}"`), "the form posts back to the same link");
  assert.ok(!html.includes(a) && !html.includes("example.com") && !html.includes("Tester") && !html.includes(contactOf(a).id), "no address, name or id on the page");
  assert.equal(res.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("x-robots-tag")!, /noindex/);
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.ok(!/<script|<img|<link|<iframe|http:\/\/|https:\/\//.test(html), "no script and no external resource");
  assert.equal(JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression")]), before, "GET changed nothing");
  assert.equal((await getMarketingEligibility(a, { db: D(), now: NOW })).eligible, true);
  assert.equal((await getMarketingEligibility(b, { db: D(), now: NOW })).eligible, true);
});

test("ROUTE GET: e-mail security scanners, link previewers and prefetchers cannot unsubscribe anyone, however often they fetch", async () => {
  await dispatched(1);
  const a = E(1)[0];
  const before = JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression"), db.rows("emailContact")]);
  const robots = [
    { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { "user-agent": "Microsoft Office Protect/ATP SafeLinks" }, { "user-agent": "Mimecast URL Protect" },
    { "user-agent": "Slackbot-LinkExpanding 1.0" }, { "user-agent": "facebookexternalhit/1.1" }, { "purpose": "prefetch", "sec-purpose": "prefetch;prerender" }, { "x-requested-with": "XMLHttpRequest" },
    { range: "bytes=0-100" }, { accept: "*/*" }, {},
  ];
  for (const h of robots) {
    for (const method of ["GET", "HEAD"]) {
      const res = await get(tokenOf(a), h, method);
      assert.equal(res.status, 200, `${method} ${JSON.stringify(h)}`);
    }
  }
  assert.equal(JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression"), db.rows("emailContact")]), before);
  assert.equal((await getMarketingEligibility(a, { db: D(), now: NOW })).eligible, true, "still subscribed after 20 scanner fetches");
  // ...and a POST that is not a one-click POST (a bot blindly POSTing) does nothing either.
  for (const [body, type] of [[null, null], ["", FORM], ["x=1", FORM], ["List-Unsubscribe=Yes", FORM], [ONE_CLICK, "application/json"], [ONE_CLICK, null]] as const) {
    assert.equal((await post(tokenOf(a), body, type)).status, 400, `${body} ${type}`);
  }
  assert.equal((await getMarketingEligibility(a, { db: D(), now: NOW })).eligible, true);
});

test("ROUTE POST: a valid RFC 8058 one-click POST unsubscribes through the P08 service: consent closed (source LINK) and an UNSUBSCRIBED suppression", async () => {
  await dispatched(2);
  const [a, b] = E(2);
  const res = await post(tokenOf(a), ONE_CLICK, FORM);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You are unsubscribed/);
  const consent = db.rows("marketingConsent").find((c) => c.contactId === contactOf(a).id)!;
  assert.ok(consent.unsubscribedAt instanceof Date);
  assert.equal(consent.unsubscribeSource, "LINK");
  const sup = db.rows("emailSuppression").find((s) => s.email === a)!;
  assert.equal(sup.reason, "UNSUBSCRIBED");
  assert.equal(sup.contactId, contactOf(a).id);
  assert.deepEqual(await getMarketingEligibility(a, { db: D(), now: NOW }), { eligible: false, reason: "suppressed" });
  assert.equal((await getMarketingEligibility(b, { db: D(), now: NOW })).eligible, true, "nobody else was affected");
  assert.equal(db.rows("emailSuppression").length, 1);
});

test("ROUTE POST: the multipart one-click format and the confirmation page's own form post work too", async () => {
  await dispatched(2);
  const multipart = '--bnd\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--bnd--\r\n';
  assert.equal((await post(tokenOf(E(2)[0]), multipart, "multipart/form-data; boundary=bnd")).status, 200);
  assert.equal(db.rows("emailSuppression").find((s) => s.email === E(2)[0])!.reason, "UNSUBSCRIBED");
  const page = await (await get(tokenOf(E(2)[1]))).text();
  const field = page.match(/name="([^"]+)" value="([^"]+)"/)!;
  assert.equal((await post(tokenOf(E(2)[1]), `${encodeURIComponent(field[1])}=${encodeURIComponent(field[2])}`, "application/x-www-form-urlencoded; charset=UTF-8")).status, 200);
  assert.equal(db.rows("emailSuppression").find((s) => s.email === E(2)[1])!.reason, "UNSUBSCRIBED");
});

test("ROUTE POST: repeating it is idempotent: same answer, one suppression, the consent closed once and its timestamp unchanged", async () => {
  await dispatched(1);
  const a = E(1)[0];
  const first = await post(tokenOf(a));
  const snapshot = stateOf(a);
  const closedAt = db.rows("marketingConsent")[0].unsubscribedAt.getTime();
  for (let i = 0; i < 4; i++) {
    const again = await post(tokenOf(a));
    assert.equal(again.status, 200);
    assert.equal(await again.text(), await first.clone().text(), "the identical page every time");
  }
  assert.equal(stateOf(a), snapshot, "nothing changed on repeats");
  assert.equal(db.rows("emailSuppression").length, 1);
  assert.equal(db.rows("marketingConsent")[0].unsubscribedAt.getTime(), closedAt);
});

test("ROUTE POST: concurrent one-click requests for one contact end in one suppression and one closed consent", async () => {
  await dispatched(1);
  const a = E(1)[0];
  const results = await Promise.all(Array.from({ length: 6 }, () => post(tokenOf(a))));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(db.rows("emailSuppression").filter((s) => s.email === a).length, 1);
  assert.equal(db.rows("marketingConsent").filter((c) => c.contactId === contactOf(a).id && c.unsubscribedAt === null).length, 0);
});

test("ROUTE POST: a stronger suppression (bounce, complaint, admin) is never weakened by an unsubscribe", async () => {
  await dispatched(3);
  const reasons = ["BOUNCED", "COMPLAINED", "ADMIN"] as const;
  for (let i = 0; i < 3; i++) await suppressEmail(E(3)[i], { reason: reasons[i], note: "from provider" }, { db: D(), now: NOW });
  for (let i = 0; i < 3; i++) {
    const res = await post(tokenOf(E(3)[i]));
    assert.equal(res.status, 200);
    const sup = db.rows("emailSuppression").find((s) => s.email === E(3)[i])!;
    assert.equal(sup.reason, reasons[i], `${reasons[i]} stays ${reasons[i]}`);
    assert.equal(sup.liftedAt, null);
    assert.deepEqual(await getMarketingEligibility(E(3)[i], { db: D(), now: NOW }), { eligible: false, reason: "suppressed" });
  }
});

test("ROUTE: invalid, malformed, forged, unknown and unissued tokens all get the same generic 404 page; nothing reveals whether a contact exists", async () => {
  await dispatched(1);
  const real = tokenOf(E(1)[0]);
  const neverIssued = deriveUnsubscribeToken(UNSUB_SECRET, "someone_who_never_got_mail")!; // well-formed, correct signature, but no stored hash
  const flipped = (real[0] === "A" ? "B" : "A") + real.slice(1);
  const bad = ["short", "x".repeat(200), "%00%0d%0a", "../../admin", "A".repeat(43), flipped, neverIssued];
  const bodies = new Set<string>();
  for (const token of bad) {
    for (const res of [await get(token), await post(token)]) {
      assert.equal(res.status, 404, token.slice(0, 20));
      bodies.add(await res.text());
    }
  }
  assert.equal(bodies.size, 1, "one identical generic body for every kind of invalid link");
  const body = [...bodies][0];
  assert.ok(!/@|example\.com|Tester|user1|exist|unknown|no such|forged/i.test(body.replace(/not valid|incorrect/g, "")), "says nothing about why");
  assert.equal(db.rows("emailSuppression").length, 0);
});

test("ROUTE: nothing about the contact appears in ANY response: no address, name, id, or difference between subscribed and already-blocked contacts", async () => {
  await dispatched(2);
  const [a, b] = E(2);
  await suppressEmail(b, { reason: "BOUNCED" }, { db: D(), now: NOW });
  const pages: string[] = [];
  for (const e of [a, b]) {
    pages.push(await (await get(tokenOf(e))).text());
    pages.push(await (await post(tokenOf(e))).text());
  }
  const noToken = (p: string) => p.replaceAll(tokenOf(a), "T").replaceAll(tokenOf(b), "T");
  assert.equal(noToken(pages[0]), noToken(pages[2]), "GET page identical for a subscribed and a bounced contact (apart from the link's own token)");
  assert.equal(pages[1], pages[3], "POST page identical too");
  for (const p of pages.map(noToken)) for (const needle of [a, b, "example.com", "Tester", contactOf(a).id, contactOf(b).id, "BOUNCED", "UNSUBSCRIBED"]) assert.ok(!p.includes(needle), needle);
});

test("ROUTE: a missing secret answers a generic 503 (the link stays valid, nothing changes); an oversize body is refused; unexpected errors are generic and log no token", async () => {
  await dispatched(1);
  const a = E(1)[0];
  const t = tokenOf(a);
  const before = stateOf(a);
  await withUnsubEnv({ EMAIL_UNSUBSCRIBE_SECRET: undefined }, async () => {
    assert.equal((await get(t)).status, 503);
    assert.equal((await post(t)).status, 503);
    assert.equal((await get("short")).status, 404, "a malformed token is still just invalid");
  });
  assert.equal(stateOf(a), before);
  assert.equal((await post(t, ONE_CLICK + "&x=" + "a".repeat(2000))).status, 413);
  assert.equal(stateOf(a), before);

  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (name: string) => { if (name === "emailContact") throw Object.assign(new Error(`boom ${t} ${a}`), { code: "X" }); return orig(name); };
  const res = await post(t);
  delete (db as any).delegate;
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes(t) && !text.includes(a) && !text.includes("boom"));
  assert.ok(!logs.lines.join("\n").includes(t) && !logs.lines.join("\n").includes(a), "the error's message (which contained the token and address) is not logged: only its class");
});

test("ROUTE: nothing is logged on any path: no token, URL, address or secret", async () => {
  await dispatched(2);
  await run();
  for (const e of E(2)) { await get(tokenOf(e)); await post(tokenOf(e)); }
  await get("bad"); await post("bad");
  const all = logs.lines.join("\n");
  for (const e of E(2)) for (const needle of [tokenOf(e), urlOf(e), e, UNSUB_SECRET, hashUnsubscribeToken(tokenOf(e))!]) assert.ok(!all.includes(needle), needle.slice(0, 20));
  assert.ok(!all.includes("/api/email/unsubscribe/"), "not even the path of a link");
});

test("ROUTE: the link from the List-Unsubscribe header works end to end, and unsubscribing stops the NEXT campaign", async () => {
  const f1 = await dispatched(2, { name: "First" });
  await run();
  const mail = smtp.mails.find((m) => m.to === E(2)[0])!;
  const url = mail.headers["List-Unsubscribe"].slice(1, -1);
  const token = url.slice(url.lastIndexOf("/") + 1);
  const f2 = await scheduledCampaign(db, E(2), { reuse: true, name: "Second" }); // audience prepared while both are still subscribed
  assert.equal((await post(token)).status, 200);
  assert.equal(f1.recipients().length, 2);
  const r2 = await go(f2.campaignId);
  assert.ok(r2.ok);
  assert.deepEqual([r2.enqueued, r2.skipped], [1, 1], "the person who unsubscribed gets no job in the next campaign");
  assert.equal(recipientFor(f2, E(2)[0]).skipReason, "suppressed");
});

// ================================================================================================================ campaign dispatch

test("DISPATCH: a campaign without {{unsubscribeUrl}} is rejected before anything starts, with nothing queued, no state change and no token written", async () => {
  for (const [textBody, htmlBody, code, field] of [
    ["Hello {{customerName}}", "<p>hi {{unsubscribeUrl}}</p>", "unsubscribe_link_missing", "textBody"],
    ["Hello {{unsubscribeUrl}}", "<p>no link here</p>", "unsubscribe_link_missing", "htmlBody"],
    ["Hello", null, "unsubscribe_link_missing", "textBody"],
  ] as const) {
    db = freshDb(); discardAfter();
    const f = await scheduledCampaign(db, E(2), { textBody, htmlBody: htmlBody as never, legacy: true }); // Prompt 12: scheduling itself now refuses these; this proves dispatch still does
    const r = await go(f.campaignId);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsubscribe_link_missing");
    assert.ok(r.errors.some((e: any) => e.field === field && e.code === code), JSON.stringify(r.errors));
    assert.equal(jobs().length, 0);
    assert.equal(db.rows("emailCampaign")[0].status, "SCHEDULED", "never moved to SENDING");
    assert.ok(f.recipients().every((x) => x.status === "PENDING"));
    assert.ok(db.rows("emailContact").every((c) => !c.unsubscribeTokenHash));
  }
});

test("DISPATCH: {{unsubscribeUrl}} in the subject is refused (the subject outlives the e-mail body on the job row)", async () => {
  const f = await scheduledCampaign(db, E(1), { subject: "Leave {{unsubscribeUrl}}", legacy: true }); // Prompt 12: scheduling itself now refuses this; dispatch still does
  const r = await go(f.campaignId);
  assert.equal(r.reason, "unsubscribe_link_missing");
  assert.ok(r.errors.some((e: any) => e.code === "unsubscribe_url_in_subject"));
  assert.equal(jobs().length, 0);
});

test("DISPATCH: every job carries ITS recipient's own valid link, in the text and the HTML, and that link resolves to that contact only", async () => {
  const f = await dispatched(4);
  const seen = new Set<string>();
  for (const e of E(4)) {
    const job = jobFor(f, e);
    const m = job.text.match(/Unsubscribe: (https:\/\/shop\.example\.com\/api\/email\/unsubscribe\/([A-Za-z0-9_-]{43}))$/)!;
    assert.ok(m, job.text);
    assert.equal(m[1], urlOf(e));
    assert.ok(job.html.includes(`<a href="${m[1]}">`));
    assert.ok(!job.subject.includes(m[2]), "never in the subject");
    assert.equal((await resolveUnsubscribeToken(m[2], { db: D() }) as any).email, e);
    seen.add(m[2]);
    for (const other of E(4).filter((x) => x !== e)) assert.ok(!job.text.includes(tokenOf(other)) && !job.html.includes(tokenOf(other)), "no one else's link");
  }
  assert.equal(seen.size, 4);
});

test("DISPATCH: if the secret or base URL cannot make links, nothing is queued, the campaign is not started, and it dispatches normally once fixed", async () => {
  const f = await scheduledCampaign(db, E(3));
  for (const env of [
    { EMAIL_UNSUBSCRIBE_SECRET: undefined }, { EMAIL_UNSUBSCRIBE_SECRET: "short" }, { EMAIL_UNSUBSCRIBE_SECRET: "a".repeat(64) },
    { EMAIL_UNSUBSCRIBE_SECRET: process.env.AUTH_SECRET ?? "x" },
  ]) {
    await withUnsubEnv({ AUTH_SECRET: "auth-secret-for-this-test-0123456789abcdef", ...env, ...(env.EMAIL_UNSUBSCRIBE_SECRET === process.env.AUTH_SECRET ? { EMAIL_UNSUBSCRIBE_SECRET: "auth-secret-for-this-test-0123456789abcdef" } : {}) }, async () => {
      const r = await go(f.campaignId);
      assert.equal(r.reason, "unsubscribe_link_unavailable");
      assert.ok(!JSON.stringify(r).includes(UNSUB_SECRET));
    });
  }
  for (const base of ["http://shop.example.com", "https://localhost", "https://shop.example.com/shop", ""]) {
    await withUnsubEnv({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: base }, async () => assert.equal((await go(f.campaignId)).reason, "unsubscribe_link_unavailable", base));
  }
  assert.equal(jobs().length, 0);
  assert.equal(db.rows("emailCampaign")[0].status, "SCHEDULED");
  assert.ok(db.rows("emailContact").every((c) => !c.unsubscribeTokenHash));
  const ok = await go(f.campaignId);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(jobs().length, 3);
});

test("DISPATCH: a SENDING campaign that loses its secret stops cleanly (resume is refused, nothing more is queued) and resumes when it is back", async () => {
  const f = await scheduledCampaign(db, E(4), { chunkSize: 2 });
  const orig = (db as any).delegate.bind(db);
  let calls = 0;
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailJob") { const cm = d.createMany.bind(d); d.createMany = async (a: any) => { calls++; if (calls === 2) throw new Error("disk full"); return cm(a); }; } return d; };
  assert.equal((await go(f.campaignId, { chunkSize: 2 })).reason, "interrupted");
  delete (db as any).delegate;
  const queued = jobs().length;
  assert.equal(queued, 2);
  await withUnsubEnv({ EMAIL_UNSUBSCRIBE_SECRET: undefined }, async () => assert.equal((await go(f.campaignId, { chunkSize: 2 })).reason, "unsubscribe_link_unavailable"));
  assert.equal(jobs().length, queued, "nothing queued while links cannot be created");
  const resumed = await go(f.campaignId, { chunkSize: 2 });
  assert.ok(resumed.ok && resumed.resumed, JSON.stringify(resumed));
  assert.equal(jobs().length, 4);
  for (const e of E(4)) assert.equal(jobFor(f, e).text.match(/Unsubscribe: (\S+)$/)![1], urlOf(e), "the resumed half has the same stable links as the first half");
});

test("DISPATCH: when ONE recipient's link cannot be created, that recipient is FAILED (never queued) and the others still go out", async () => {
  const f = await scheduledCampaign(db, E(3));
  // Corruption that would make a second contact share user1's link hash: refused instead of written.
  // (A contact INSIDE the campaign that holds a wrong hash is simply repaired by dispatch; the conflict must come from outside it.)
  const a = contactOf(E(3)[0]);
  const stranger = (await optedIn(db, "stranger@example.com")).contact;
  await (db as any).emailContact.update({ where: { id: stranger.id }, data: { unsubscribeTokenHash: hashUnsubscribeToken(deriveUnsubscribeToken(UNSUB_SECRET, a.id)!) } });
  const r = await go(f.campaignId);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.enqueued, r.failed], [2, 1]);
  const failed = f.recipients().find((x) => x.status === "FAILED")!;
  assert.equal(failed.contactId, a.id);
  assert.equal(failed.errorCode, "unsubscribe_unavailable");
  assert.equal(failed.emailJobId, null);
  assert.ok(!jobs().some((j) => j.toEmail === E(3)[0]), "no job for the recipient without a link");
  assert.equal(jobs().length, 2);
});

test("DISPATCH: the message builder itself refuses to produce an e-mail without the exact link (defence in depth)", () => {
  const contact = { id: "c1", email: "eve@example.com", name: "Eve" };
  const cfg = readUnsubscribeConfig(process.env);
  assert.ok(cfg.ok);
  const snap = { subject: "s", textBody: "t {{unsubscribeUrl}}", htmlBody: "<a href=\"{{unsubscribeUrl}}\">u</a>" };
  const good = `${UNSUB_BASE}${UNSUBSCRIBE_ROUTE_PREFIX}${"A".repeat(43)}`;
  assert.equal(buildCampaignMessage("k", "r", contact, snap, "S", good as never).ok, true, "the same snapshot and a well-formed URL do build");
  assert.equal(buildCampaignMessage("k", "r", contact, { ...snap, textBody: "no link" }, "S", good as never).ok, false);
  for (const url of ["", "https://evil.example.com/x", `${good}?x=1`, "javascript:alert(1)", undefined, null]) {
    assert.equal(buildCampaignMessage("k", "r", contact, snap, "S", url as never).ok, false, String(url));
  }
});

test("DISPATCH: deduplication and resume stay intact: a retried dispatch queues nothing twice and every job keeps its link", async () => {
  const f = await dispatched(5);
  const before = jobs().map((j) => [j.id, j.dedupeKey, j.text]);
  assert.equal((await go(f.campaignId)).reason, "already_dispatched");
  assert.equal((await go(f.campaignId)).reason, "already_dispatched");
  assert.deepEqual(jobs().map((j) => [j.id, j.dedupeKey, j.text]), before);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
  // A job that already exists for a recipient is reused (not duplicated), and keeps working.
  const rec = f.recipients()[0];
  await (db as any).emailCampaignRecipient.update({ where: { id: rec.id }, data: { status: "PENDING", emailJobId: null, queuedAt: null } });
  const again = await go(f.campaignId);
  assert.ok(again.ok, JSON.stringify(again));
  assert.deepEqual([again.enqueued, again.reusedJobs], [1, 1]);
  assert.equal(jobs().length, 5);
});

test("DISPATCH: suppressed, unsubscribed, withdrawn and inactive recipients get no job and no link is created for them", async () => {
  const f = await scheduledCampaign(db, E(5));
  await suppressEmail(E(5)[0], { reason: "UNSUBSCRIBED" }, { db: D(), now: NOW });
  await suppressEmail(E(5)[1], { reason: "BOUNCED" }, { db: D(), now: NOW });
  await suppressEmail(E(5)[2], { reason: "COMPLAINED" }, { db: D(), now: NOW });
  await suppressEmail(E(5)[3], { reason: "ADMIN" }, { db: D(), now: NOW });
  const r = await go(f.campaignId);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.enqueued, r.skipped], [1, 4]);
  assert.deepEqual(jobs().map((j) => j.toEmail), [E(5)[4]]);
  for (const e of E(5).slice(0, 4)) assert.ok(!contactOf(e).unsubscribeTokenHash, `no token hash written for ${e}`);
  await post(tokenOf(E(5)[4]));
  await run();
  assert.equal(smtp.mails.length, 0, "the last one unsubscribed before the worker ran: nothing is sent to anyone");
});

// =========================================================================================================================== headers + worker

test("HEADERS: a campaign e-mail goes out with List-Unsubscribe (the recipient's own https URL) and List-Unsubscribe-Post: List-Unsubscribe=One-Click", async () => {
  const f = await dispatched(3);
  const r = await run();
  assert.equal(r.sent, 3);
  for (const e of E(3)) {
    const mail = smtp.mails.find((m) => m.to === e)!;
    assert.deepEqual(mail.headers, { "List-Unsubscribe": `<${urlOf(e)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    assert.match(mail.headers["List-Unsubscribe"], /^<https:\/\/[^\s<>]+>$/);
    assert.ok(mail.text.includes(urlOf(e)) && mail.html.includes(urlOf(e)), "the header URL is the same as the link in the body");
    assert.deepEqual(Object.keys(mail.headers).sort(), ["List-Unsubscribe", "List-Unsubscribe-Post"], "no other header was added");
  }
  assert.ok(f.recipients().every((x) => x.status === "SENT"));
});

test("HEADERS: transactional e-mail is unchanged: no headers, the same message shape as before Prompt 11", async () => {
  const q = await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-1001"], to: "buyer@example.com", subject: "Your order", text: "Thanks", html: "<p>Thanks</p>" }, { db: D(), now: NOW, kick: false });
  assert.ok(q.ok);
  const r = await run();
  assert.equal(r.sent, 1);
  const mail = smtp.mails[0];
  assert.deepEqual(Object.keys(mail).sort(), ["from", "html", "subject", "text", "to"], "exactly the pre-P11 keys: no `headers` key at all");
  assert.equal(mail.headers, undefined);
  assert.equal(JSON.stringify(mail).includes("Unsubscribe"), false);
});

test("HEADERS: the SMTP layer refuses injection and anything but the two List-Unsubscribe headers; transport and auth options are untouched", async () => {
  const url = `${UNSUB_BASE}${UNSUBSCRIBE_ROUTE_PREFIX}${"A".repeat(43)}`;
  const good = { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const base = { to: "a@example.com", subject: "s", text: "t" };
  const bad: any[] = [
    { ...good, "List-Unsubscribe": `<${url}>\r\nBcc: evil@example.com` }, { ...good, "List-Unsubscribe": `<${url}>\nX-Injected: 1` }, { ...good, "X-Extra": "1" },
    { ...good, "List-Unsubscribe": "<http://shop.example.com/x>" }, { ...good, "List-Unsubscribe": "<mailto:u@example.com>" }, { ...good, "List-Unsubscribe": `<${url}>, <https://evil.com/x>` },
    { ...good, "List-Unsubscribe-Post": "List-Unsubscribe=Nope" }, { "List-Unsubscribe": `<${url}>` }, "x", [],
  ];
  for (const headers of bad) {
    const opened = smtp.opened;
    const res = await sendSmtpMail({ ...base, headers }, SMTP_ENV, smtp.factory);
    assert.deepEqual([res.ok, (res as any).code], [false, "send_rejected"], JSON.stringify(headers).slice(0, 70));
    assert.equal(smtp.opened, opened, "refused before any connection was opened");
  }
  assert.equal(smtp.mails.length, 0);
  assert.ok((await sendSmtpMail({ ...base, headers: good }, SMTP_ENV, smtp.factory)).ok);
  assert.deepEqual(smtp.mails[0].headers, good);
  const plain = await sendSmtpMail(base, SMTP_ENV, smtp.factory);
  assert.ok(plain.ok);
  assert.equal("headers" in smtp.mails[1], false, "no headers key when none were given");
  const src = (await import("node:fs")).readFileSync(new URL("../../src/lib/email/smtp.ts", import.meta.url), "utf8");
  assert.ok(src.includes("requireTLS: !c.secure") && src.includes('minVersion: "TLSv1.2"') && src.includes("auth: { user: c.user, pass: c.pass }"), "transport/auth options unchanged");
});

test("WORKER: an e-mail queued WITHOUT a link (for example before Prompt 11) is never sent: the job and the recipient are FAILED with a fixed code", async () => {
  const f = await dispatched(2);
  const job = jobFor(f, E(2)[0]);
  await (db as any).emailJob.update({ where: { id: job.id }, data: { text: "Hello, no link in this one", html: "<p>none</p>" } });
  const r = await run();
  assert.deepEqual([r.sent, r.skipped], [1, 1]);
  assert.deepEqual(smtp.mails.map((m) => m.to), [E(2)[1]]);
  assert.equal(db.rows("emailJob").find((j) => j.id === job.id)!.errorCode, "unsubscribe_link_missing");
  const rec = recipientFor(f, E(2)[0]);
  assert.deepEqual([rec.status, rec.errorCode], ["FAILED", "unsubscribe_link_missing"]);
  // A body that has the link only in the text (HTML without it) is refused too.
  await (db as any).emailJob.update({ where: { id: jobFor(f, E(2)[1]).id }, data: { status: "PENDING", attempts: 0, text: `ok ${urlOf(E(2)[1])}`, html: "<p>none</p>" } });
  await (db as any).emailCampaignRecipient.update({ where: { id: recipientFor(f, E(2)[1]).id }, data: { status: "QUEUED" } });
  const before = smtp.mails.length;
  await run({ now: new Date(NOW.getTime() + 1000) });
  assert.equal(smtp.mails.length, before);
});

test("WORKER: someone else's link in the body is not good enough, and a secret changed after dispatch (every old link now dead) blocks the send", async () => {
  const f = await dispatched(2);
  const [a, b] = E(2);
  await (db as any).emailJob.update({ where: { id: jobFor(f, a).id }, data: { text: `Hi ${urlOf(b)}`, html: `<a href="${urlOf(b)}">x</a>` } });
  await run();
  assert.deepEqual(smtp.mails.map((m) => m.to), [b], "A's e-mail carried B's link, so it was not sent");
  assert.equal(recipientFor(f, a).errorCode, "unsubscribe_link_missing");

  const g = await scheduledCampaign(db, E(2), { reuse: true, name: "Later" });
  assert.ok((await go(g.campaignId)).ok);
  smtp.mails.length = 0;
  await withUnsubEnv({ EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET + "-rotated" }, async () => { await run(); });
  assert.equal(smtp.mails.length, 0, "links in the queued bodies no longer match the secret: nothing goes out with a dead link");
  assert.ok(g.recipients().every((x) => x.status === "FAILED" && x.errorCode === "unsubscribe_link_missing"));
});

test("WORKER: with no usable secret at send time nothing is sent and recipients are FAILED(unsubscribe_unavailable); no SMTP connection is opened for them", async () => {
  const f = await dispatched(2);
  await withUnsubEnv({ EMAIL_UNSUBSCRIBE_SECRET: undefined }, async () => { await run(); });
  assert.equal(smtp.mails.length, 0);
  assert.ok(f.recipients().every((x) => x.status === "FAILED" && x.errorCode === "unsubscribe_unavailable"));
});

test("WORKER: re-checks eligibility before SMTP exactly as before: unsubscribed or suppressed after queueing means not sent", async () => {
  await dispatched(4);
  await post(tokenOf(E(4)[0]));
  await suppressEmail(E(4)[1], { reason: "COMPLAINED" }, { db: D(), now: NOW });
  const r = await run();
  assert.deepEqual([r.sent, r.skipped], [2, 2]);
  assert.deepEqual(smtp.mails.map((m) => m.to).sort(), [E(4)[2], E(4)[3]]);
});

test("WORKER: logs from dispatch, the worker and SMTP failures never contain a token, a link, an address or the secret", async () => {
  await dispatched(3);
  smtp.behaviour = async () => { throw Object.assign(new Error(`rejected ${UNSUB_SECRET} ${urlOf(E(3)[0])}`), { code: "ETIMEDOUT" }); };
  await run();
  const all = logs.lines.join("\n");
  for (const e of E(3)) for (const needle of [tokenOf(e), e, UNSUB_SECRET, "/api/email/unsubscribe/"]) assert.ok(!all.includes(needle), needle.slice(0, 24));
});

test("CONTACT HYGIENE: creating links changes only unsubscribeTokenHash and only for dispatched contacts; consent, suppression and eligibility rules are untouched", async () => {
  const f = await scheduledCampaign(db, E(3));
  await optedIn(db, "bystander@example.com");
  const before = JSON.stringify(db.rows("emailContact").map(({ unsubscribeTokenHash: _h, ...rest }) => rest));
  const consentsBefore = JSON.stringify(db.rows("marketingConsent"));
  await go(f.campaignId);
  assert.equal(JSON.stringify(db.rows("emailContact").map(({ unsubscribeTokenHash: _h, ...rest }) => rest)), before);
  assert.equal(JSON.stringify(db.rows("marketingConsent")), consentsBefore);
  assert.ok(!contactOf("bystander@example.com").unsubscribeTokenHash, "a contact not in the campaign got no token hash");
  assert.equal(db.rows("emailSuppression").length, 0);
  void T0;
});

// ===================================================================================================== plaintext-token retention on EmailJob

const failWith = (code: string) => async () => { throw Object.assign(new Error("smtp"), { code }); };
const bodyHasToken = (email: string) => JSON.stringify(jobs().filter((j) => j.toEmail === email).map((j) => [j.text, j.html])).includes(tokenOf(email));

test("RETENTION: a permanently failed campaign job drops its body (and so the token); a transactional job that fails permanently is untouched", async () => {
  await dispatched(2);
  const tx = await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-2001"], to: "buyer@example.com", subject: "Your order", text: "Thanks for your order", html: "<p>Thanks</p>" }, { db: D(), now: NOW, kick: false });
  assert.ok(tx.ok);
  smtp.behaviour = async (m: any) => (m.to === E(2)[0] || m.to === "buyer@example.com" ? failWith("EENVELOPE")() : { messageId: "<i@g>", accepted: [m.to], rejected: [] });
  const r = await run();
  assert.equal(r.failed, 2);
  const campaignJob = jobs().find((j) => j.toEmail === E(2)[0])!;
  assert.deepEqual([campaignJob.status, campaignJob.errorCode, campaignJob.text, campaignJob.html], ["FAILED", "recipient_rejected", "", null], "campaign body dropped");
  assert.equal(bodyHasToken(E(2)[0]), false);
  const txJob = jobs().find((j) => j.toEmail === "buyer@example.com")!;
  assert.deepEqual([txJob.status, txJob.text, txJob.html], ["FAILED", "Thanks for your order", "<p>Thanks</p>"], "transactional queue behaviour is exactly as before");
});

test("RETENTION: while a retry is still possible the body is KEPT, and the retry sends with the link and both headers; the body goes only when it is sent", async () => {
  await dispatched(1);
  const a = E(1)[0];
  smtp.behaviour = failWith("ETIMEDOUT");
  const first = await run();
  assert.deepEqual([first.sent, first.retryScheduled], [0, 1]);
  const pending = jobs().find((j) => j.toEmail === a)!;
  assert.equal(pending.status, "PENDING");
  assert.ok(pending.text.includes(urlOf(a)) && pending.html.includes(urlOf(a)), "body kept for the retry");
  smtp.behaviour = async (m: any) => ({ messageId: "<i@g>", accepted: [m.to], rejected: [] });
  const second = await run({ now: new Date(NOW.getTime() + 3 * 3_600_000) });
  assert.equal(second.sent, 1);
  const mail = smtp.mails[smtp.mails.length - 1];
  assert.deepEqual(mail.headers, { "List-Unsubscribe": `<${urlOf(a)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.ok(mail.text.includes(urlOf(a)));
  assert.deepEqual([jobs()[0].status, jobs()[0].text], ["SENT", ""]);
});

test("RETENTION: a campaign job that runs out of retries drops its body", async () => {
  await dispatched(1);
  smtp.behaviour = failWith("ECONNREFUSED");
  for (let i = 0; i < EMAIL_JOB_MAX_ATTEMPTS; i++) await run({ now: new Date(NOW.getTime() + (i + 1) * 3 * 3_600_000) });
  const j = jobs()[0];
  assert.deepEqual([j.status, j.attempts, j.text, j.html], ["FAILED", EMAIL_JOB_MAX_ATTEMPTS, "", null]);
  assert.equal(bodyHasToken(E(1)[0]), false);
});

test("RETENTION: housekeeping's out-of-attempts failure drops a campaign body but leaves other kinds exactly as before", async () => {
  await dispatched(1);
  const tx = await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-2002"], to: "buyer@example.com", subject: "Your order", text: "Thanks for your order", html: null }, { db: D(), now: NOW, kick: false });
  assert.ok(tx.ok);
  for (const j of jobs()) await (db as any).emailJob.update({ where: { id: j.id }, data: { attempts: EMAIL_JOB_MAX_ATTEMPTS } });
  const r = await run();
  assert.equal(r.housekeeping.exhausted, 2, "both jobs are settled, as before");
  const campaignJob = jobs().find((j) => j.toEmail === E(1)[0])!;
  const txJob = jobs().find((j) => j.toEmail === "buyer@example.com")!;
  assert.deepEqual([campaignJob.status, campaignJob.errorCode, campaignJob.text, campaignJob.html], ["FAILED", "attempts_exhausted", "", null]);
  assert.deepEqual([txJob.status, txJob.errorCode, txJob.text], ["FAILED", "attempts_exhausted", "Thanks for your order"]);
  assert.equal(smtp.mails.length, 0, "nothing was sent for either");
});

test("RETENTION: after every terminal outcome no table holds a token (sent, failed, skipped, blocked); only a job still waiting for a retry does", async () => {
  await dispatched(4);
  await post(tokenOf(E(4)[0]));                       // skipped at send time
  smtp.behaviour = async (m: any) => (m.to === E(4)[1] ? failWith("EENVELOPE")() : m.to === E(4)[2] ? failWith("ETIMEDOUT")() : { messageId: "<i@g>", accepted: [m.to], rejected: [] });
  await run();
  const everything = (skip?: string) => JSON.stringify(["emailContact", "marketingConsent", "emailSuppression", "emailCampaign", "emailCampaignRecipient", "emailTemplate", "emailJob"].map((t) => db.rows(t).filter((r) => !skip || r.toEmail !== skip)));
  for (const e of [E(4)[0], E(4)[1], E(4)[3]]) assert.ok(!everything().includes(tokenOf(e)), `${e}: terminal, no token left anywhere`);
  assert.ok(everything().includes(tokenOf(E(4)[2])), "the one job waiting for its retry still has its body (it needs it)");
  assert.ok(!everything(E(4)[2]).includes(tokenOf(E(4)[2])), "and that body is the ONLY place it is");
});

// ===================================================================================================== crash-exhausted body cleanup (deliverEmailJob catch path)

/** A database that works for the claim and the final settle but throws once while the job is being read after the claim: the "delivery crashed" path. */
function crashingOnce() {
  const real = (db as any).emailJob;
  let reads = 0;
  return { emailJob: { updateMany: (a: any) => real.updateMany(a), findUnique: async (a: any) => { reads += 1; if (reads === 1) throw new Error(`connection lost ${UNSUB_SECRET}`); return real.findUnique(a); } } };
}
const crashDeliver = (id: string) => deliverEmailJob(id, { db: crashingOnce() as never, env: SMTP_ENV, factory: smtp.factory, now: NOW });
const setAttempts = (id: string, attempts: number) => (db as any).emailJob.update({ where: { id }, data: { attempts } });
const queueTransactional = async () => {
  const r = await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-3001"], to: "buyer@example.com", subject: "Your order", text: "Thanks for your order", html: "<p>Thanks</p>" }, { db: D(), now: NOW, kick: false });
  assert.ok(r.ok);
  return jobs().find((j) => j.toEmail === "buyer@example.com")!;
};

test("CRASH: a campaign job whose delivery crashes on its LAST attempt is FAILED (attempts_exhausted) and its token-bearing text AND html are cleared", async () => {
  await dispatched(1);
  const a = E(1)[0];
  const id = jobs().find((x) => x.toEmail === a)!.id;
  assert.equal(bodyHasToken(a), true, "precondition: the queued body holds the recipient's token");
  await setAttempts(id, EMAIL_JOB_MAX_ATTEMPTS - 1);
  await crashDeliver(id);
  const j = jobs().find((x) => x.id === id)!;
  assert.deepEqual([j.status, j.errorCode, j.attempts, j.lockedAt, j.text, j.html], ["FAILED", "attempts_exhausted", EMAIL_JOB_MAX_ATTEMPTS, null, "", null]);
  assert.equal(bodyHasToken(a), false, "no token left in the job");
  assert.ok(!JSON.stringify(db.rows("emailJob")).includes(tokenOf(a)));
  assert.equal(smtp.mails.length, 0, "the crash happened before SMTP: nothing was sent");
  assert.doesNotMatch(logs.lines.join("\n"), new RegExp(`${tokenOf(a)}|${UNSUB_SECRET}|connection lost|user1@example`), "logs hold the error class only");
});

test("CRASH: a campaign job whose delivery crashes with retries REMAINING stays PENDING and keeps its body, and the retry then sends it with link and headers", async () => {
  await dispatched(1);
  const a = E(1)[0];
  const id = jobs()[0].id;
  await crashDeliver(id); // attempt 1 of 5
  const j = jobs()[0];
  assert.deepEqual([j.status, j.errorCode, j.attempts, j.lockedAt], ["PENDING", "internal", 1, null]);
  assert.ok(j.text.includes(urlOf(a)) && j.html.includes(urlOf(a)), "text and html kept for the retry");
  assert.equal(j.nextAttemptAt.getTime(), NOW.getTime() + EMAIL_INTERNAL_RETRY_MS, "the existing internal-retry delay is unchanged");
  const r = await run({ now: new Date(NOW.getTime() + EMAIL_INTERNAL_RETRY_MS + 1000) });
  assert.equal(r.sent, 1);
  const mail = smtp.mails[0];
  assert.ok(mail.text.includes(urlOf(a)));
  assert.deepEqual(mail.headers, { "List-Unsubscribe": `<${urlOf(a)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.deepEqual([jobs()[0].status, jobs()[0].text, jobs()[0].html], ["SENT", "", null]);
});

test("CRASH: transactional jobs are unchanged: the same crash keeps the body whether it is exhausted (FAILED) or not (PENDING)", async () => {
  const tx = await queueTransactional();
  await crashDeliver(tx.id); // retries remain
  let j = jobs().find((x) => x.id === tx.id)!;
  assert.deepEqual([j.status, j.errorCode, j.attempts, j.text, j.html], ["PENDING", "internal", 1, "Thanks for your order", "<p>Thanks</p>"]);
  await setAttempts(tx.id, EMAIL_JOB_MAX_ATTEMPTS - 1);
  await (db as any).emailJob.update({ where: { id: tx.id }, data: { nextAttemptAt: NOW } });
  await crashDeliver(tx.id); // last attempt
  j = jobs().find((x) => x.id === tx.id)!;
  assert.deepEqual([j.status, j.errorCode, j.attempts, j.lockedAt, j.text, j.html], ["FAILED", "attempts_exhausted", EMAIL_JOB_MAX_ATTEMPTS, null, "Thanks for your order", "<p>Thanks</p>"], "exactly as before Prompt 11: the body is not touched");
  assert.equal(smtp.mails.length, 0);
});
