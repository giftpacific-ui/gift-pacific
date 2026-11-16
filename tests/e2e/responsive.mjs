import { launch, newPage, BASE, adminCookie, custCookie } from "./lib.mjs";
import fs from "node:fs";
const axeSrc = fs.readFileSync("/home/claude/e2e/node_modules/axe-core/axe.min.js", "utf8");
const VPS = [[360, 740], [390, 844], [768, 1024], [1366, 768], [1440, 900]];
const PUBLIC = ["/", "/shop", "/shop/gifts", "/products/e2e-product-5", "/campaign", "/boxes", "/cart", "/checkout", "/login", "/register", "/contact", "/about"];
const CUST = ["/account", "/account/orders"]; const ADMIN = ["/admin", "/admin/campaigns", "/admin/products/new", "/admin/banners", "/admin/settings", "/admin/orders", "/admin/boxes"];
const mode = process.argv[2]; const b = await launch();
const set = mode === "admin" ? ADMIN : mode === "cust" ? CUST : PUBLIC; const cookies = mode === "admin" ? adminCookie() : mode === "cust" ? custCookie() : [];
const rows = [], axeAgg = {}; let loads = 0;
for (const [w, h] of VPS) {
  const { page, errors, failed } = await newPage(b, { width: w, height: h, cookies });
  for (const path of set) {
    errors.length = 0; failed.length = 0; loads++;
    let status = 0; try { const r = await page.goto(BASE + path, { waitUntil: "networkidle0", timeout: 60000 }); status = r.status(); } catch (e) { rows.push({ w, path, issue: "NAVIGATION " + e.message.slice(0, 60) }); continue; }
    await new Promise((r) => setTimeout(r, 300));
    const m = await page.evaluate(() => {
      const iw = innerWidth, over = [];
      for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > iw + 1 && getComputedStyle(el).position !== "fixed") { let p = el.parentElement, clipped = false; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") { clipped = true; break; } p = p.parentElement; } if (!clipped) over.push(el.tagName + "." + String(el.className).slice(0, 40) + " r=" + Math.round(r.right)); } }
      const imgs = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src).startsWith(location.origin) && !decodeURIComponent(i.currentSrc || i.src).includes("picsum.photos") && !decodeURIComponent(i.currentSrc || i.src).includes("res.cloudinary.com"));
      const noAlt = [...document.images].filter((i) => !i.hasAttribute("alt")).length;
      const unnamed = [...document.querySelectorAll("button,a,input:not([type=hidden]),select,textarea")].filter((e) => !(e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || (e.textContent || "").trim() || e.getAttribute("title") || e.getAttribute("placeholder") || (e.labels && e.labels.length) || e.getAttribute("alt") || e.querySelector("img[alt]:not([alt=''])")) && e.type !== "file" ).length;
      return { scrollW: document.documentElement.scrollWidth, iw, over: over.slice(0, 3), brokenSameOrigin: imgs.length, noAlt, unnamed, lang: document.documentElement.lang, h1: document.querySelectorAll("h1").length, title: document.title.length };
    });
    const real = errors.filter((e) => !/Failed to load resource|net::ERR|blocked|picsum|cloudinary|example\.com/i.test(e));
    const rf = failed.filter((f) => !/_rsc=|ERR_ABORTED/.test(f));
    const issues = []; if (status >= 400 && status !== 404) issues.push("HTTP " + status);
    if (m.scrollW > m.iw + 1) issues.push(`H-OVERFLOW page ${m.scrollW}>${m.iw} ${m.over.join(",")}`); else if (m.over.length) issues.push("overflow-el " + m.over[0]);
    if (m.brokenSameOrigin) issues.push(`${m.brokenSameOrigin} broken same-origin img`); if (m.unnamed) issues.push(`${m.unnamed} controls without an accessible name`);
    if (!m.lang) issues.push("html lang missing"); if (!m.title) issues.push("empty <title>"); if (real.length) issues.push("console: " + real[0]); if (rf.length) issues.push("failed req: " + rf[0].slice(0, 80));
    if (m.h1 !== 1) issues.push(`h1 count=${m.h1}`);
    rows.push({ w, path, issues });
    if ((w === 390 || w === 1366) ) { try { await page.evaluate(axeSrc); const r = await page.evaluate(async () => { const x = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }); return x.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })); }); for (const v of r) { const k = v.id + "|" + v.impact; (axeAgg[k] ??= { pages: new Set(), nodes: 0 }); axeAgg[k].pages.add(path + "@" + w); axeAgg[k].nodes += v.n; } } catch (e) { rows.push({ w, path, issues: ["axe failed " + e.message.slice(0, 50)] }); } }
  }
  await page.close();
}
const bad = rows.filter((r) => r.issues?.length || r.issue);
console.log(`MODE ${mode}: ${loads} page loads (${set.length} pages x ${VPS.length} viewports); pages with layout/console/a11y-basic issues: ${bad.length}`);
const agg = {}; for (const r of bad) for (const i of r.issues || [r.issue]) { const k = i.replace(/\d+/g, "N").slice(0, 70); (agg[k] ??= []).push(r.path + "@" + r.w); }
for (const [k, v] of Object.entries(agg)) console.log(`  ISSUE ${k} :: ${v.length}x e.g. ${[...new Set(v)].slice(0, 3).join(", ")}`);
console.log("AXE (wcag2a/aa/21aa/22aa) violations by rule:"); for (const [k, v] of Object.entries(axeAgg).sort((a, b) => b[1].nodes - a[1].nodes)) console.log(`  ${k.padEnd(34)} nodes=${String(v.nodes).padEnd(4)} pages=${[...v.pages].slice(0, 3).join(", ")}${v.pages.size > 3 ? " +" + (v.pages.size - 3) : ""}`);
await b.close(); process.exit(0);
