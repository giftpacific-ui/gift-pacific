import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import fs from "node:fs";
export const BASE = "http://localhost:3400";
export const tokens = Object.fromEntries(fs.readFileSync("/tmp/tokens4.txt","utf8").trim().split("\n").map(l=>l.split("=")));
export async function launch() {
  return puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, "--no-sandbox"], headless: "shell" });
}
// External hosts are unreachable in the sandbox: block them so they don't pollute console/network results.
export async function newPage(browser, { width = 390, height = 844, cookies = [] } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
  await page.evaluateOnNewDocument(() => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = 'html,body{scroll-behavior:auto !important}'; document.head.appendChild(s); }); });
  const errors = [], failed = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => { const u = r.url(); if (u.startsWith("https://api.cloudinary.com/")) return; if (u.startsWith(BASE) || u.startsWith("data:") || u.startsWith("blob:")) r.continue(); else r.abort("blockedbyclient"); });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e.message).slice(0, 200)));
  page.on("requestfailed", (r) => { if (r.url().startsWith(BASE)) failed.push(r.url() + " " + r.failure()?.errorText); });
  for (const c of cookies) await page.setCookie({ url: BASE, ...c });
  return { page, errors, failed };
}
export const adminCookie = () => [{ name: "admin_session", value: tokens.ADMIN_TOKEN }];
export const custCookie = () => [{ name: "session", value: tokens.CUST_TOKEN }];
