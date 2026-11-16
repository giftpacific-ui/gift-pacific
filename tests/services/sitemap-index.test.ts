import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedCatalog } from "../setup/helpers";
import { GET } from "@/app/sitemap-index/route";
import robots from "@/app/robots";
import nextConfig from "../../next.config";
import { getSitemapIds } from "@/server/services/sitemap.service";

beforeEach(() => { const db = freshDb(); seedCatalog(db); });

test("/sitemap.xml is a valid sitemap index listing every existing sitemap chunk", async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/xml/);
  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<sitemap><loc>([^<]+)<\/loc><\/sitemap>/g)].map((m) => m[1]);
  const ids = await getSitemapIds();
  assert.ok(ids.includes(0), "the pages sitemap (id 0) always exists");
  assert.equal(locs.length, ids.length);
  ids.forEach((id, i) => assert.ok(locs[i].endsWith(`/sitemap/${id}.xml`), locs[i]));
  assert.ok(locs.every((l) => /^https?:\/\//.test(l)));
});

test("robots.txt points at the route that now exists", async () => {
  const r = await robots();
  const sitemap = Array.isArray(r.sitemap) ? r.sitemap[0] : r.sitemap;
  assert.ok(String(sitemap).endsWith("/sitemap.xml"));
});

test("next.config.ts rewrites /sitemap.xml to the index handler (before the file system)", async () => {
  const rw = (await nextConfig.rewrites!()) as { beforeFiles: { source: string; destination: string }[] };
  assert.deepEqual(rw.beforeFiles, [{ source: "/sitemap.xml", destination: "/sitemap-index" }]);
});
