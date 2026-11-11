import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getFeaturedReviews } from "@/server/services/review.service";
import { searchSuggestionsAction } from "@/server/actions/search.actions";
import { siteConfig } from "@/config/site";

let db: FakeDb;
beforeEach(() => {
  n = 0;
  db = freshDb();
  seedCatalog(db);
  db.insert("user", { id: "u1", name: "Nusrat Jahan Khan", email: "n@example.com", passwordHash: "HASH" });
  db.insert("productImage", { id: "i1", productId: "p-standard", url: "https://res.cloudinary.com/x/vase.png", isMain: true });
});
let n = 0;
// one review per customer per product — so each fixture review gets its own customer (the first is "Nusrat")
const review = (o: Record<string, unknown>) => {
  const userId = n++ === 0 ? "u1" : `extra${n}`;
  if (userId !== "u1") db.insert("user", { id: userId, name: `Customer ${n}`, email: `c${n}@example.com` });
  const row = { productId: "p-standard", userId, rating: 5, title: "Lovely", body: "A really lovely piece, arrived well packed.", isApproved: true, ...o } as Record<string, unknown>;
  // Same backfill the migration applies to pre-existing rows.
  row.status = row.status ?? (row.isApproved ? "APPROVED" : row.rejectedAt ? "REJECTED" : "PENDING");
  return db.insert("review", row);
};

test("homepage reviews: only real, APPROVED, 4–5★, substantial, on ACTIVE products; short reviewer name", async () => {
  assert.deepEqual(await getFeaturedReviews(), []); // nothing invented when there are no reviews
  review({ id: "ok" });
  review({ id: "pending", isApproved: false });
  review({ id: "rejected", isApproved: false, rejectedAt: new Date() });
  review({ id: "low", rating: 3 });
  review({ id: "short", body: "ok" });
  db.insert("product", { id: "p-draft", name: "Draft", slug: "draft", status: "DRAFT", price: 5, stock: 1 });
  review({ id: "draftprod", productId: "p-draft" });
  const r = await getFeaturedReviews();
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { rating: 5, title: "Lovely", body: "A really lovely piece, arrived well packed.", reviewerName: "Nusrat K.", productName: "Clay Vase", productSlug: "clay-vase" });
  const json = JSON.stringify(r);
  for (const w of ["HASH", "n@example.com", "Jahan", "userId", "isApproved"]) assert.ok(!json.includes(w), w);
});

test("homepage reviews: bodies are bounded and the limit is respected", async () => {
  for (let i = 0; i < 8; i++) review({ id: `r${i}`, body: "x".repeat(500) });
  const r = await getFeaturedReviews(3);
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.body.length === 280));
});

test("search suggestions: public fields only, ACTIVE products, bounded input", async () => {
  const res = await searchSuggestionsAction("clay");
  assert.deepEqual(res.map((s) => s.slug).sort(), ["clay-mug", "clay-vase"]);
  const vase = res.find((s) => s.slug === "clay-vase")!;
  assert.deepEqual(Object.keys(vase).sort(), ["categoryName", "imageUrl", "inStock", "name", "price", "slug"]);
  assert.equal(vase.imageUrl, "https://res.cloudinary.com/x/vase.png");
  const json = JSON.stringify(res);
  for (const w of ["costPrice", "\"stock\"", "sku", "MUG-R", "p-standard"]) assert.ok(!json.includes(w), w);
  assert.deepEqual(await searchSuggestionsAction("c"), []); // too short
  assert.deepEqual(await searchSuggestionsAction("   "), []);
  assert.deepEqual(await searchSuggestionsAction(42 as never), []);
  assert.deepEqual(await searchSuggestionsAction("zzzzzz"), []);
  await db.product.update({ where: { id: "p-standard" }, data: { status: "DRAFT" } });
  assert.deepEqual((await searchSuggestionsAction("clay")).map((s) => s.slug), ["clay-mug"]);
  await searchSuggestionsAction("a".repeat(5000)); // does not throw
});

test("siteConfig no longer carries placeholder social links or hard-coded category navigation", () => {
  assert.ok(!("links" in siteConfig));
  assert.ok(!("nav" in siteConfig));
});
