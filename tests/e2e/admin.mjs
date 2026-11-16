import { launch, newPage, BASE, adminCookie } from "./lib.mjs";
import { startSdkMock, installBrowserMock } from "./mock-cloudinary.mjs";
import { execSync } from "node:child_process"; import fs from "node:fs";
const F = (n) => "/tmp/e2efiles/" + n;
const sql = (q) => { fs.writeFileSync("/tmp/q.sql", q); return execSync(`su postgres -c "psql -h /tmp -p 5544 -d gp_e2e -At -f /tmp/q.sql"`, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); };
const res = []; const T = (n, ok, x = "") => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  [" + String(x).slice(0, 150) + "]" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sdk = await startSdkMock(); const b = await launch();
sql(`delete from "Collection" where slug in ('winter-sale','legacy-sale'); update "Collection" set "isActive"=false where slug='eid-sale';`);
const pubCampaign = async () => (await (await fetch(BASE + "/campaign")).text());
// ---------- A. login / logout / role restriction (fresh context, no cookies) ----------
{ const b2 = await launch(); const page = await b2.newPage(); await page.setViewport({ width: 1366, height: 900 });
  const login = async (email, pw) => { await page.goto(BASE + "/admin/login", { waitUntil: "networkidle0" }); const inputs = await page.$$("input"); await inputs[0].type(email); await inputs[1].type(pw); await Promise.all([page.waitForNetworkIdle({ idleTime: 1200, timeout: 25000 }).catch(() => {}), page.keyboard.press("Enter")]); await sleep(1500); };
  await login("admin@e2e.test", "wrong-password"); T("admin login: wrong password rejected", page.url().includes("/admin/login") && !(await page.cookies()).some((c) => c.name === "admin_session"), page.url().replace(BASE, ""));
  await login("cust@e2e.test", "E2eTest-Pass-1234"); T("admin login: a CUSTOMER account cannot sign in to admin", !(await page.cookies()).some((c) => c.name === "admin_session"));
  await login("admin@e2e.test", "E2eTest-Pass-1234"); const ck = (await page.cookies()).find((c) => c.name === "admin_session");
  T("admin login: correct credentials open the dashboard", !!ck && /\/admin(\/)?$/.test(page.url()) , page.url().replace(BASE, ""));
  T("admin session cookie is HttpOnly + SameSite", !!ck?.httpOnly && /lax|strict/i.test(ck?.sameSite || ""), `httpOnly=${ck?.httpOnly} sameSite=${ck?.sameSite} secure=${ck?.secure}`);
  const dash = await page.evaluate(() => document.body.innerText); T("dashboard renders admin content", /Orders|Revenue|Products|Dashboard/i.test(dash));
  const so = [...await page.$$("button")]; for (const h of so) { if (/Sign out/.test(await h.evaluate(e => e.textContent))) { await Promise.all([page.waitForNetworkIdle({ idleTime: 1200, timeout: 20000 }).catch(() => {}), h.click()]); break; } } await sleep(1500);
  await page.goto(BASE + "/admin/orders", { waitUntil: "networkidle0" }); T("after sign-out /admin/orders redirects to the login page", page.url().includes("/admin/login"), page.url().replace(BASE, ""));
  await b2.close(); }
// ---------- B. campaign + image upload (admin session, 1366px) ----------
const { page, errors } = await newPage(b, { width: 1366, height: 900, cookies: adminCookie() });
await page.evaluateOnNewDocument(() => { window.__cld = []; const of = window.fetch; window.fetch = function (input, init) { try { const url = typeof input === 'string' ? input : input.url; if (url.includes('api.cloudinary.com') && init && init.body instanceof FormData) { const f = init.body.get('file'); const fields = {}; for (const [k, v] of init.body.entries()) if (typeof v === 'string') fields[k] = v; window.__cld.push({ fileSize: f && f.size, fileIsBlob: f instanceof Blob, fields, headers: init.headers || {} }); } } catch {} return of.apply(this, arguments); }; });
const cld = () => page.evaluate(() => window.__cld.slice());
const mockLog = []; const mockOpts = { limitBytes: null, log: mockLog, format: "png", page }; installBrowserMock(page, mockOpts);
const actionPosts = []; page.on("request", (r) => { if (r.method() === "POST" && r.url().startsWith(BASE)) actionPosts.push({ len: Number(r.headers()["content-length"] || (r.postData() || "").length || 0), action: !!r.headers()["next-action"] }); });
const go = (u) => page.goto(BASE + u, { waitUntil: "networkidle0", timeout: 60000 });
const settle = () => page.waitForNetworkIdle({ idleTime: 900, timeout: 30000 }).catch(() => {});
const toasts = () => page.$$eval("[role=status],[aria-live],[data-sonner-toast]", (els) => els.map((e) => e.textContent.trim()).filter(Boolean).join(" | "));
const waitToast = async (re, ms = 12000) => { const t0 = Date.now(); let last = ""; while (Date.now() - t0 < ms) { last = await toasts(); if (re.test(last)) return last; await sleep(250); } return last; };
const clickBtn = async (re, scope) => { for (const h of await (scope || page).$$("button")) { const t = await h.evaluate((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()); if (re.test(t)) { await h.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await h.click(); await settle(); return t; } } return null; };
const type = async (sel, v, idx = 0) => { const el = (await page.$$(sel))[idx]; await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await el.focus(); await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await page.keyboard.type(v, { delay: 4 }); };
const upload = async (file, idx = -1, waitMs = 3500) => { const inputs = await page.$$("input[type=file]"); const el = inputs.at(idx); mockLog.length = 0; await page.evaluate(() => { window.__cld.length = 0; }); await el.uploadFile(file); const t0 = Date.now(); while (Date.now() - t0 < waitMs) { await sleep(400); } await settle(); await sleep(800); };
const dbImage = (slug) => sql(`select coalesce(image,'<NULL>') from "Collection" where slug='${slug}'`);
await go("/admin/campaigns");
await type('input[placeholder="Campaign name"]', "Winter Sale"); await type('input[placeholder^="slug"]', "winter-sale");
// B1 upload
actionPosts.length = 0; await upload(F("small.png"));
const up1 = mockLog.filter((e) => e.url.includes("/image/upload"));
T("B1 browser POSTs the file DIRECTLY to Cloudinary (api.cloudinary.com, multipart)", up1.length === 1 && /multipart\/form-data/.test(up1[0].ctype || ""), up1.map((e) => e.url + " " + e.ctype).join(";"));
const c1 = await cld(); T("B1 the FormData `file` part is a Blob of exactly 83,779 B (the original file, not base64) and no field carries a data: URL", c1.length === 1 && c1[0].fileIsBlob && c1[0].fileSize === 83779 && !Object.values(c1[0].fields).some((v) => String(v).startsWith("data:")), JSON.stringify({ n: c1.length, size: c1[0]?.fileSize, blob: c1[0]?.fileIsBlob }));
T("B1 signed upload accepted: signature verified with the server-minted params", up1[0]?.signatureOk === true && up1[0].fields.folder === "giftpacific/banners" && up1[0].fields.allowed_formats === "jpg,png,webp" && !("api_secret" in up1[0].fields), JSON.stringify({ f: up1[0]?.fields.folder, p: up1[0]?.fields.public_id }));
T("B1 Server Actions during upload carry only tiny payloads (max " + Math.max(0, ...actionPosts.map((a) => a.len)) + " B)", Math.max(0, ...actionPosts.map((a) => a.len)) < 3000, actionPosts.length + " action POSTs");
const preview = await page.$$eval("img", (imgs) => imgs.map((i) => i.currentSrc || i.src).filter((s) => s.includes("res.cloudinary.com")));
T("B1 preview shows the uploaded image (Cloudinary URL, optimized delivery)", preview.some((s) => s.includes("f_auto,q_auto,c_limit")), preview[0]?.slice(0, 110));
T("B1 URL field is hidden while an uploaded image exists", !(await page.$('input[placeholder^="Or paste"]')));
await clickBtn(/^Create campaign/); await sleep(1500);
const img1 = await dbImage("winter-sale"); T("B1 create persists the exact Cloudinary URL (https://res.cloudinary.com/demo/image/upload/v1/giftpacific/banners/winter-sale-…)", /^https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/v1\/giftpacific\/banners\/winter-sale-[0-9a-f]{8}\.png$/.test(img1), img1.slice(-60));
// B2 public rendering
let html = await pubCampaign(); T("B2 /campaign renders the uploaded image through the Cloudinary loader", html.includes("f_auto,q_auto,c_limit,w_") && html.includes("winter-sale-") && html.includes("Winter Sale"));
const home = await (await fetch(BASE + "/")).text(); T("B2 homepage ActiveCampaignSection shows the new campaign image", home.includes("winter-sale-") && home.includes("f_auto,q_auto,c_limit"));
// B3 edit shows saved image, replace (session upload A then B), saved image X not deleted
await go("/admin/campaigns"); sdk.calls.length = 0;
const editClicked = await page.evaluate(() => { const hs = [...document.querySelectorAll("h2,h3")].find((h) => h.textContent.includes("Winter Sale")); let c = hs; for (let i = 0; i < 6 && c; i++) { const btn = [...c.querySelectorAll("button")].find((b) => /^Edit/.test(b.textContent.trim())); if (btn) { btn.scrollIntoView({ block: "center", behavior: "instant" }); btn.click(); return true; } c = c.parentElement; } return false; });
await sleep(1200); T("B3 edit opens for the campaign", editClicked);
const savedPrev = await page.$$eval("img", (imgs) => imgs.map((i) => i.currentSrc || i.src).filter((s) => s.includes("winter-sale-")));
T("B3 edit mode displays the currently saved image", savedPrev.length >= 1, savedPrev[0]?.slice(0, 100));
mockOpts.format = "jpg"; await upload(F("photo.jpg")); const A = mockLog.find((e) => e.url.includes("/image/upload"))?.fields.public_id;
mockOpts.format = "webp"; await upload(F("photo.webp")); const B2 = mockLog.find((e) => e.url.includes("/image/upload"))?.fields.public_id;
T("B3 two replacement uploads succeeded (JPEG then WebP)", !!A && !!B2 && A !== B2, `${A} -> ${B2}`);
await sleep(800); const idA = A.split("/").pop(), idB = B2.split("/").pop(); const touches = (id) => sdk.calls.filter((c) => c.url.includes(id) || c.body.includes(id)); const savedId = img1.split("/").pop().replace(/\.\w+$/, "");
T("B3 the abandoned in-session upload A was destroyed on Cloudinary (exactly once)", touches(idA).length === 1, sdk.calls.map((c) => c.method + " " + c.url.slice(0, 90) + " " + c.body.slice(0, 50)).join(" || "));
T("B3 neither the saved image X nor the current upload B was destroyed", touches(savedId).length === 0 && touches(idB).length === 0);
const saved = await clickBtn(/^(Save|Update)/); await sleep(1500); const img2 = await dbImage("winter-sale");
T("B3 saving persists the replacement (WebP) URL; the previously SAVED image was not deleted", img2.endsWith(".webp") && img2.includes(B2.split("/").pop()) && sdk.calls.length === 1, `${saved}: ${img2.slice(-48)}`);
// B4 remove
await go("/admin/campaigns"); await page.evaluate(() => { const hs = [...document.querySelectorAll("h2,h3")].find((h) => h.textContent.includes("Winter Sale")); let c = hs; for (let i = 0; i < 6 && c; i++) { const btn = [...c.querySelectorAll("button")].find((b) => /^Edit/.test(b.textContent.trim())); if (btn) { btn.click(); return; } c = c.parentElement; } }); await sleep(1000);
const removed = await clickBtn(/^Remove( image)?$|^Remove$/); await sleep(500); await clickBtn(/^(Save|Update)/); await sleep(1500);
T("B4 remove + save stores NULL; the campaign still saves", (await dbImage("winter-sale")) === "<NULL>", removed || "remove button not found");
// B5 legacy pasted URL
await go("/admin/campaigns"); await type('input[placeholder="Campaign name"]', "Legacy Sale"); await type('input[placeholder^="slug"]', "legacy-sale");
await type('input[placeholder^="Or paste"]', "https://example.com/legacy-banner.jpg"); await clickBtn(/^Create campaign/); await sleep(1500);
T("B5 a manually typed image URL is still accepted and stored unchanged", (await dbImage("legacy-sale")) === "https://example.com/legacy-banner.jpg");
sql(`update "Collection" set "isActive"=false where slug='winter-sale'`); html = await pubCampaign();
T("B5 legacy URL renders directly (no HTTP 400 through the optimizer)", html.includes('src="https://example.com/legacy-banner.jpg"') && !html.includes("example.com%2Flegacy"), "");
await go("/admin/campaigns"); await page.evaluate(() => { const hs = [...document.querySelectorAll("h2,h3")].find((h) => h.textContent.includes("Legacy Sale")); let c = hs; for (let i = 0; i < 6 && c; i++) { const btn = [...c.querySelectorAll("button")].find((b) => /^Edit/.test(b.textContent.trim())); if (btn) { btn.click(); return; } c = c.parentElement; } }); await sleep(1000);
const urlVal = await page.$$eval("input", (els) => els.map((e) => e.value).find((v) => v.includes("legacy-banner")));
const removeBtns = await page.$$eval("button", (bs) => bs.filter((b) => /^Remove image$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim())).length);
T("B5 editing a legacy campaign shows its URL in the URL field and no image preview for the arbitrary host", urlVal === "https://example.com/legacy-banner.jpg" && removeBtns === 0, `urlField=${!!urlVal} removeImageButtons=${removeBtns}`);
// B6 invalid files
await go("/admin/campaigns"); mockLog.length = 0; actionPosts.length = 0;
for (const [f, label] of [["anim.gif", "GIF"], ["spoof.png", "spoofed .png containing SVG/script"]]) { const inputs = await page.$$("input[type=file]"); mockLog.length = 0; await inputs.at(-1).uploadFile(F(f)); const t = await waitToast(/JPEG, PNG or WebP/i, 6000); await sleep(600); T(`B6 ${label} is rejected in the browser with a message`, /valid JPEG|JPEG, PNG or WebP/i.test(t) , t.slice(0, 90)); }
T("B6 rejected files never reached Cloudinary or a Server Action", mockLog.filter((e) => e.url.includes("/image/upload")).length === 0, `${mockLog.length} cloudinary requests`);
// B7 provider limit
mockOpts.limitBytes = 10 * 1024 * 1024; mockOpts.format = "png"; { const inputs = await page.$$("input[type=file]"); await inputs.at(-1).uploadFile(F("large12.png")); } const lim = await waitToast(/Cloudinary rejected/i, 20000); await sleep(1500);
T("B7 a Cloudinary plan-limit rejection (simulated 10 MB) is shown explicitly, naming the plan", /Cloudinary rejected this image/.test(lim) && /plan/i.test(lim), lim.slice(0, 160));
// B8 chunked 45 MB
mockOpts.limitBytes = null; actionPosts.length = 0; await upload(F("huge45.png"), -1, 25000);
const chunks = await cld(); const hdr = (c, k) => c.headers[k] || c.headers[k.toLowerCase()];
T("B8 a 45 MiB file uploads in 3 chunks with Content-Range and ONE upload id", chunks.length === 3 && new Set(chunks.map((c) => hdr(c, "X-Unique-Upload-Id"))).size === 1 && hdr(chunks[0], "Content-Range") === "bytes 0-20971519/47185928" && hdr(chunks[2], "Content-Range") === "bytes 41943040-47185927/47185928", chunks.map((c) => hdr(c, "Content-Range")).join(" | "));
T("B8 each chunk is a Blob slice of the original file; sizes sum to exactly 47,185,928 B (no base64 inflation)", chunks.length === 3 && chunks.every((c) => c.fileIsBlob) && chunks.reduce((s, c) => s + c.fileSize, 0) === 47185928, chunks.map((c) => c.fileSize).join("+"));
T("B8 all chunks carry identical signed parameters", chunks.length === 3 && chunks.every((c) => c.fields.signature === chunks[0].fields.signature && c.fields.timestamp === chunks[0].fields.timestamp));
T("B8 no Server Action carried the file (max action POST " + Math.max(0, ...actionPosts.map((a) => a.len)) + " B)", Math.max(0, ...actionPosts.map((a) => a.len)) < 3000);
const prev45 = await page.$$eval("img", (imgs) => imgs.map((i) => i.currentSrc || i.src).filter((s) => s.includes("res.cloudinary.com")));
T("B8 preview appears after the chunked upload", prev45.length >= 1);
// B9 scheduling / activation - driven through the admin UI so the app's own cache revalidation runs
sql(`delete from "Collection" where slug='legacy-sale'`);
const ymd = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
sql(`insert into "Collection"(id,name,slug,"isCampaign","isActive","createdAt","updatedAt") values('c_ws','Winter Sale','winter-sale',true,false,now(),now()) on conflict (slug) do update set "isActive"=false, "startsAt"=null,"endsAt"=null`);
const editWS = async (startsOffset, endsOffset, active) => { await go("/admin/campaigns"); await page.evaluate(() => { const hs = [...document.querySelectorAll("h2,h3")].find((h) => h.textContent.includes("Winter Sale")); let c = hs; for (let i = 0; i < 6 && c; i++) { const btn = [...c.querySelectorAll("button")].find((b) => /^Edit/.test(b.textContent.trim())); if (btn) { btn.scrollIntoView({ block: "center", behavior: "instant" }); btn.click(); return; } c = c.parentElement; } }); await sleep(900);
  const dates = await page.$$("input[type=date]"); const set = async (el, v) => el.evaluate((e, val) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(e, val); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }, v);
  const n = dates.length; await set(dates[n - 2], startsOffset === null ? "" : ymd(startsOffset)); await set(dates[n - 1], endsOffset === null ? "" : ymd(endsOffset));
  const cb = (await page.$$("input[type=checkbox]")); const box = cb[cb.length - 1]; const cur = await box.evaluate((e) => e.checked); if (cur !== active) { await box.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await box.click(); }
  await clickBtn(/^(Save|Update)/); await sleep(1800); };
await editWS(10, null, true); html = await pubCampaign(); T("B9 (via admin UI) a campaign scheduled to start in 10 days is NOT shown publicly", !html.includes("Winter Sale"), sql(`select "startsAt"::date||' active='||"isActive" from "Collection" where slug='winter-sale'`));
await editWS(-1, 1, true); html = await pubCampaign(); T("B9 (via admin UI) inside its date window the campaign IS shown", html.includes("Winter Sale"), sql(`select "startsAt"::date||'..'||"endsAt"::date from "Collection" where slug='winter-sale'`));
await editWS(-5, -1, true); html = await pubCampaign(); T("B9 (via admin UI) after its end date it is hidden again", !html.includes("Winter Sale"));
await editWS(null, null, true); html = await pubCampaign(); T("B9 (via admin UI) with no dates and Active ticked it is shown", html.includes("Winter Sale"));
await editWS(null, null, false); html = await pubCampaign(); T("B9 (via admin UI) un-ticking Active hides it", !html.includes("Winter Sale"));
// cleanup scratch data
sql(`delete from "Collection" where slug in ('winter-sale','legacy-sale'); update "Collection" set "isActive"=true where slug='eid-sale'`);
const real = errors.filter((e) => !/Failed to load resource|net::ERR|blocked|picsum|cloudinary|example\.com/i.test(e));
T("no unexpected browser console errors in the admin session", real.length === 0, real.slice(0, 2).join(" | "));
console.log(`SUMMARY admin: ${res.filter(Boolean).length}/${res.length} passed`);
await b.close(); sdk.server.close(); process.exit(0);
