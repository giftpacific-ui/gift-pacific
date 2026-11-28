/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12-UI-03: e-mail images (store logo, hero banner, product card) must reach the customer as absolute, public https URLs, unchanged.
 * Root cause covered here: outside production the designer accepted http://localhost (and relative / own-origin / /_next/image) addresses, so the
 * designer preview (loaded by the admin's own browser) showed them while a real mail client could not. The REAL designer, template, campaign, dispatch,
 * queue-worker and SMTP code runs (in-memory database, fake SMTP transport); the assertions are made on the HTML handed to SMTP.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, scheduledCampaign, SMTP_ENV } from "../setup/campaign-dispatch-fixture";
import { defaultDesign, newBlock, type Block, type Design } from "@/lib/email-template-blocks";
import { resolveImageUrl } from "@/lib/email/designer/design";
import { adminPreviewEmailDesign, adminSaveEmailTemplate } from "@/server/services/email-template-designer.service";
import { dispatchEmailCampaign } from "@/server/services/email-campaign-dispatch.service";
import { processEmailQueue } from "@/server/services/email-queue.service";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED_ENV.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED;
  process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb(); smtp = makeSmtp(); discardAfter(); seedAdmins(db); seedCatalog(db); logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  if (SAVED_ENV.RATE_LIMIT_ENABLED === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = SAVED_ENV.RATE_LIMIT_ENABLED;
});

const A = "admin-1";
const D = () => db as never;
const PUBLIC_ENV = { NEXT_PUBLIC_APP_URL: "https://giftpacific.test", NODE_ENV: "test", ...SMTP_ENV, SMTP_FROM_NAME: "GiftPacific", SMTP_FROM_EMAIL: "" };
const DEV_ENV = { ...PUBLIC_ENV, NEXT_PUBLIC_APP_URL: "http://localhost:3000", NODE_ENV: "development" };
const LOGO = "https://res.cloudinary.com/demo/image/upload/v1/giftpacific/logo-a1b2c3d4.png";
const HERO = "https://res.cloudinary.com/demo/image/upload/v1/giftpacific/hero-banner.jpg?w=1200&q=80";
const PRODUCT = "https://res.cloudinary.com/demo/image/upload/v1/giftpacific/vase.jpg";
const RUNWORKER = () => processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });

const setLogo = (url: string | null) => db.patch("storeSettings", "singleton", { logoUrl: url });
const header = (): Block => ({ ...newBlock("header"), showLogo: true }) as Block;
const hero = (imageUrl: string): Block => ({ ...newBlock("hero"), heading: "Big sale", imageUrl, imageAlt: "Sale banner" }) as Block;
const product = (): Block => ({ ...newBlock("product"), productId: "p-standard" }) as Block;
const design = (...mid: Block[]): Design => { const x = defaultDesign(); return { preheader: "", blocks: [header(), ...mid, x.blocks[x.blocks.length - 1]] }; };
const save = async (env: Record<string, string>, d: Design) => adminSaveEmailTemplate(A, { name: "Images", category: "MARKETING", subject: "Hello {{firstName}}", status: "ready", design: d }, { db: D(), env }) as Promise<any>;
const srcs = (html: string) => [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

/** Template -> campaign -> dispatch -> queue worker -> SMTP; returns the HTML the fake SMTP transport received. */
async function sendThroughCampaign(htmlBody: string, textBody: string): Promise<string> {
  const f = await scheduledCampaign(db, ["a@example.com"], { htmlBody, textBody, name: "Image campaign" });
  assert.ok(((await dispatchEmailCampaign(f.campaignId, { db: D(), now: NOW })) as any).ok);
  assert.equal((await RUNWORKER()).sent, 1);
  assert.equal(smtp.mails.length, 1);
  return smtp.mails[0].html as string;
}

test("logo, hero and product images keep their exact public https URLs through save, campaign snapshot, dispatch and SMTP, and match the preview", async () => {
  setLogo(LOGO);
  db.insert("productImage", { id: "img-1", productId: "p-standard", url: PRODUCT, isMain: true, sortOrder: 0, altText: null });
  const d = design(hero(HERO), product());
  const saved = await save(PUBLIC_ENV, d);
  assert.ok(saved.ok, JSON.stringify(saved));
  const row = db.rows("emailTemplate").find((t: any) => t.id === saved.id) as any;
  assert.deepEqual(srcs(row.htmlBody), [LOGO, HERO, PRODUCT], "saved template HTML");

  const html = await sendThroughCampaign(row.htmlBody, row.textBody);
  assert.deepEqual(srcs(html), [LOGO, HERO, PRODUCT], "the HTML handed to SMTP carries the very same image URLs");
  const snapshot = (db.rows("emailCampaign")[0] as any).htmlBody as string;
  assert.deepEqual(srcs(snapshot), [LOGO, HERO, PRODUCT], "campaign snapshot");
  for (const u of srcs(html)) {
    const parsed = new URL(u);
    assert.equal(parsed.protocol, "https:"); assert.ok(!/localhost|127\.0\.0\.1/.test(parsed.hostname)); assert.ok(!parsed.pathname.startsWith("/_next"));
  }
  assert.doesNotMatch(html, /gp-design/, "the internal designer marker is still stripped");
  assert.match(html, /unsubscribe/i, "the unsubscribe link is still present");

  const preview: any = await adminPreviewEmailDesign(A, { design: d }, { db: D(), env: PUBLIC_ENV });
  assert.ok(preview.ok);
  assert.deepEqual(srcs(preview.html), srcs(html), "preview and the real e-mail use equivalent image URLs");
});

test("with no store logo, the bundled logo is used on the PUBLIC https origin (absolute, never relative)", async () => {
  setLogo(null);
  const saved = await save(PUBLIC_ENV, design());
  const row = db.rows("emailTemplate").find((t: any) => t.id === saved.id) as any;
  const html = await sendThroughCampaign(row.htmlBody, row.textBody);
  assert.deepEqual(srcs(html), ["https://giftpacific.test/img/logo/logo.png"]);
});

test("development (localhost origin): no outbound image ever points at localhost; Cloudinary images still pass, own-origin images are dropped, hero is refused with a clear message", async () => {
  setLogo(null); // would have fallen back to http://localhost:3000/img/logo/logo.png
  db.insert("productImage", { id: "img-1", productId: "p-standard", url: "/uploads/vase.jpg", isMain: true, sortOrder: 0, altText: null });
  const bad = await save(DEV_ENV, design(hero("/img/login-bg.png")));
  assert.equal(bad.ok, false); assert.match(bad.message, /public https|local or private/i);
  const saved = await save(DEV_ENV, design(hero(HERO), product()));
  assert.ok(saved.ok, JSON.stringify(saved));
  const row = db.rows("emailTemplate").find((t: any) => t.id === saved.id) as any;
  assert.deepEqual(srcs(row.htmlBody), [HERO], "logo and product image on localhost are left out, never emitted as broken links");
  assert.ok(srcs(row.htmlBody).every((u) => !/localhost|127\.0\.0\.1/.test(u)), "no <img> points at localhost");
  const html = await sendThroughCampaign(row.htmlBody, row.textBody);
  assert.deepEqual(srcs(html), [HERO]);
});

test("a stored logo that is not a public image (localhost / optimizer URL) is replaced by the public bundled logo, not sent", async () => {
  for (const url of ["http://localhost:3000/img/logo/logo.png", "/_next/image?url=%2Fimg%2Flogo%2Flogo.png&w=256&q=75", "https://giftpacific.test/_next/image?url=x&w=64&q=75"]) {
    setLogo(url);
    const saved = await save(PUBLIC_ENV, design());
    const row = db.rows("emailTemplate").find((t: any) => t.id === saved.id) as any;
    assert.deepEqual(srcs(row.htmlBody), ["https://giftpacific.test/img/logo/logo.png"], url);
    db.remove("emailTemplate", () => true);
  }
});

test("image host security is unchanged: unlisted hosts, http, credentials, data: and javascript: are still refused; non-public addresses and optimizer URLs are refused", () => {
  const CTX = { origin: "https://giftpacific.test", production: true };
  const DEV = { origin: "http://localhost:3000", production: false };
  assert.equal(resolveImageUrl(HERO, CTX).ok, true);
  assert.equal((resolveImageUrl(HERO, CTX) as any).url, HERO, "a valid URL is returned exactly as given");
  assert.equal((resolveImageUrl("/img/logo/logo.png", CTX) as any).url, "https://giftpacific.test/img/logo/logo.png");
  for (const bad of ["https://evil.test/t.png", "http://res.cloudinary.com/a.png", "https://u:p@res.cloudinary.com/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "//evil.test/a.png",
    "/_next/image?url=%2Fa.png&w=64&q=75", "https://giftpacific.test/_next/image?url=a", "https://giftpacific.test/api/private/avatar", "/api/x.png"]) {
    assert.equal(resolveImageUrl(bad, CTX).ok, false, bad);
  }
  for (const bad of ["http://localhost:3000/img/logo/logo.png", "/img/logo/logo.png", "/uploads/a.png", "http://127.0.0.1:3000/a.png"]) assert.equal(resolveImageUrl(bad, DEV).ok, false, `dev: ${bad}`);
  assert.equal(resolveImageUrl(PRODUCT, DEV).ok, true, "an approved public https host works in development");
  for (const host of ["10.0.0.5", "192.168.1.9", "172.16.0.1", "169.254.1.1", "foo.local", "app.localhost"]) assert.equal(resolveImageUrl(`https://${host}/a.png`, { origin: `https://${host}`, production: true }).ok, false, host);
});
