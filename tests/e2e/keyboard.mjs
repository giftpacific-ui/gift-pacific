import { launch, newPage, BASE } from "./lib.mjs";
const b = await launch();
for (const [w, h] of [[1366, 768], [390, 844]]) {
  const { page } = await newPage(b, { width: w, height: h });
  await page.goto(BASE + "/", { waitUntil: "networkidle0", timeout: 60000 });
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => { const a = document.activeElement; return { text: (a.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 30), href: a.getAttribute("href") }; });
  let noIndicator = 0, stops = 0; const seen = new Set(); let reachedFooter = false;
  for (let i = 0; i < 80; i++) {
    const s = await page.evaluate(() => { const a = document.activeElement; if (!a || a === document.body) return null; const cs = getComputedStyle(a); const vis = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" || (a.matches(":focus-visible") && false); return { id: a.tagName + (a.getAttribute("href") || a.getAttribute("aria-label") || (a.textContent || "").trim().slice(0, 15)), vis, inFooter: !!a.closest("footer") }; });
    if (!s) break; if (seen.has(s.id) && i > 5 && seen.size > 10) { /* wrapped */ } seen.add(s.id); stops++; if (!s.vis) noIndicator++; if (s.inFooter) reachedFooter = true;
    await page.keyboard.press("Tab");
  }
  console.log(`viewport ${w}: first Tab stop = ${JSON.stringify(first)} | tab stops walked=${stops}, without visible focus style=${noIndicator}, reached footer=${reachedFooter}`);
  // menu open / Escape (mobile) or search overlay
  const opened = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^(Open menu|Search)$/.test((x.getAttribute("aria-label") || x.textContent || "").trim())); if (!b) return null; b.focus(); b.click(); return b.getAttribute("aria-label") || b.textContent.trim(); });
  await new Promise((r) => setTimeout(r, 700)); const dlg = await page.$("[role=dialog]"); await page.keyboard.press("Escape"); await new Promise((r) => setTimeout(r, 600)); const dlg2 = await page.$("[role=dialog]");
  console.log(`   '${opened}' opens a dialog: ${!!dlg}; Escape closes it: ${!!dlg && !dlg2}; focus returned to a control: ${await page.evaluate(() => document.activeElement && document.activeElement.tagName !== "BODY")}`);
  await page.close();
}
await b.close(); process.exit(0);
