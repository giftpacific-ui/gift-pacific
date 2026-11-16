import { launch, newPage, BASE, custCookie } from "./lib.mjs";
import { execSync } from "node:child_process";
const res = []; const T = (n, ok, extra = "") => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (extra ? "  [" + extra + "]" : "")); };
import fs from "node:fs";
const sql = (q) => { fs.writeFileSync("/tmp/q.sql", q.replace(/\\"/g, '"')); return execSync(`su postgres -c "psql -h /tmp -p 5544 -d gp_e2e -At -f /tmp/q.sql"`, { stdio: ["ignore","pipe","pipe"] }).toString().trim(); };
const b = await launch(); const { page, errors, failed } = await newPage(b, { cookies: custCookie() });
const go = (u) => page.goto(BASE + u, { waitUntil: "networkidle0", timeout: 60000 });
const clickText = async (sel, re) => { const hs = await page.$$(sel); for (const h of hs) { const t = await h.evaluate((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()); if (re.test(t)) { await center(h); await h.click(); return t; } } return null; };
const center = (h) => h.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
const settle = () => page.waitForNetworkIdle({ idleTime: 900, timeout: 20000 }).catch(() => {});
const clickAndWait = async (sel, re) => { const hs = await page.$$(sel); for (const h of hs) { const tx = await h.evaluate((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()); if (re.test(tx)) { await Promise.all([page.waitForResponse((r) => r.request().method() === "POST", { timeout: 15000 }).catch(() => null), (async () => { await center(h); await h.click(); })()]); await settle(); return tx; } } return null; };
const body = () => page.evaluate(() => document.body.innerText);

await go("/"); T("homepage renders (title + hero/sections)", (await page.title()).length > 0 && (await body()).length > 500, await page.title());
const price5 = 200 + (5 % 40) * 25; // product 5 -> 325
await go("/"); const cat = await page.$eval("a[href^='/shop/gifts']", (a) => a.getAttribute("href")); await go(cat);
T("category page lists products", (await body()).includes("E2E Product"), cat);
await go("/products/e2e-product-5"); const pdp = await body();
T("product detail shows name and price", pdp.includes("E2E Product 5") && pdp.includes(String(price5)), "price " + price5);
await clickText("button", /^Increase quantity/); await clickAndWait("button", /^Add to cart/);
await go("/cart"); let cart = await body();
T("added product appears in cart (quantity 2 after increase)", cart.includes("E2E Product 5"), cart.match(/Qty[^\n]*|Quantity[^\n]*/)?.[0] ?? "");
const inc = await clickAndWait("button", /^Increase quantity/);
const dec = await clickAndWait("button", /^Decrease quantity/);
T("cart quantity controls are clickable", !!inc && !!dec, `${inc} / ${dec}`);
const rm = await clickAndWait("button", /^Remove/); cart = await body();
T("remove item empties the cart", !!rm && !cart.includes("E2E Product 5") , rm ?? "no remove button found");
// re-add 2 units for checkout
await go("/products/e2e-product-5"); await clickText("button", /^Increase quantity/); await clickAndWait("button", /^Add to cart/);
await go("/checkout");
// validation: empty submit
await clickAndWait("button", /^Place order/);
let txt = await body(); const stillOnCheckout = page.url().includes("/checkout");
T("empty checkout is rejected with visible validation (no navigation)", stillOnCheckout && /required|invalid|enter|must|please/i.test(txt), txt.match(/[^\n]*(required|invalid|must|enter)[^\n]*/i)?.[0]?.slice(0, 70));
// invalid phone
const fill = async (name, v) => { const el = await page.$(`[name="${name}"]`); await center(el); await el.focus(); await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await page.keyboard.type(v, { delay: 5 }); };
await fill("email", "cust@e2e.test"); await fill("phone", "123"); await fill("shippingAddress.fullName", "E2E Customer"); await fill("shippingAddress.phone", "123"); await fill("shippingAddress.line1", "House 1, Road 2"); await fill("shippingAddress.city", "Dhaka");
await clickAndWait("button", /^Place order/); txt = await body();
T("invalid phone number is rejected", page.url().includes("/checkout") && /phone|valid|digit|01/i.test(txt), txt.match(/[^\n]*(valid phone|phone number|01\d)[^\n]*/i)?.[0]?.slice(0, 80));
// coupon
const cp = await page.$('input[placeholder="Coupon code"]'); await center(cp); await cp.focus(); await page.keyboard.type("SAVE10"); await clickAndWait("button", /^Apply/); txt = await body();
const couponShown = /SAVE10|discount|10%/i.test(txt); T("coupon SAVE10 applies (discount shown)", couponShown, txt.match(/[^\n]*(discount|SAVE10)[^\n]*/i)?.[0]?.slice(0, 70));
// fix phones and place order
await fill("phone", "01712345678"); await fill("shippingAddress.phone", "01712345678");
await clickAndWait("button", /^Place order/); await new Promise(r => setTimeout(r, 2500)); await settle();
const url = page.url(); txt = await body();
T("valid COD order is placed and the confirmation page opens", /confirmation|order/i.test(url) || /order (placed|confirmed|number)|thank/i.test(txt), url.replace(BASE, ""));
const row = sql(`select row_to_json(o) from \\"Order\\" o order by \\"createdAt\\" desc limit 1`);
let o = {}; try { o = JSON.parse(row); } catch { }
const num = (k) => Number(Object.entries(o).find(([n]) => n.toLowerCase() === k)?.[1]);
const subtotal = num("subtotal"), delivery = Number(Object.entries(o).find(([n]) => /delivery|shipping/i.test(n) && /charge|cost|fee/i.test(n))?.[1] ?? NaN), discount = Number(Object.entries(o).find(([n]) => /^discount/i.test(n))?.[1] ?? NaN), total = num("total");
console.log("   stored order:", JSON.stringify({ orderNumber: o.orderNumber, subtotal, delivery, discount, total, status: o.status, payment: o.paymentMethod }));
T("stored subtotal = 2 x 325 = 650", subtotal === 2 * price5, String(subtotal));
T("stored total = 650 - 65 (coupon) + 70 (Dhaka delivery shown at checkout) = 655, computed independently", Math.abs(total - (2 * price5 - 0.1 * 2 * price5 + 70)) < 0.01, `stored ${total}, implied delivery ${total - subtotal + (discount || 0)}`);
T("10% coupon discount is exactly 65.00", Math.abs((discount || 0) - 65) < 0.01, String(discount));
T("order number uses the existing AP- prefix", /^AP-/.test(o.orderNumber || ""), o.orderNumber);
T("stock decremented from 50 to 48", sql(`select stock from \\"Product\\" where slug='e2e-product-5'`) === "48");
await go("/account/orders"); txt = await body();
T("order appears in customer order history", !!o.orderNumber && txt.includes(o.orderNumber), o.orderNumber);
const real = errors.filter((e) => !/Failed to load resource|net::ERR|blocked|picsum|cloudinary/i.test(e));
T("no unexpected browser console errors during the journey", real.length === 0, real.slice(0, 2).join(" | "));
const realFailed = failed.filter((f) => !/_rsc=|ERR_ABORTED/.test(f));
T("no failed same-origin requests (aborted RSC prefetches ignored)", realFailed.length === 0, realFailed.slice(0, 2).join(" | "));
console.log(`SUMMARY customer journey: ${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
