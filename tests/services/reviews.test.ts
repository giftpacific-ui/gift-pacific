import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { getReviewEligibility, submitReview } from "@/server/services/review.service";
import { getReviewEligibilityAction, submitReviewAction } from "@/server/actions/review.actions";
import { adminListReviews, adminCountPendingReviews } from "@/server/services/admin-review.service";
import { moderateReviewAction } from "@/server/actions/admin-review.actions";
import { getProductBySlug } from "@/server/services/product.service";
import { validateReview } from "@/lib/review-rules";

let db: FakeDb;
beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db);
  db.insert("user", { id: "u1", name: "Nusrat Jahan", email: "n@example.com" });
  db.insert("user", { id: "u2", name: "Other Person", email: "o@example.com" });
});
const good = { rating: 5, title: "Lovely", body: "Beautiful vase, arrived well packed." };
const as = <T,>(sub: string, fn: () => Promise<T>) => runAs({ sub }, fn);

async function deliveredOrder(user: string, productId = "p-standard") {
  await as(user, () => addItemToCart({ productId, quantity: 1 }));
  const o = await as(user, () => placeOrder(emptyCheckout));
  for (const s of ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"]) await adminUpdateOrderStatus(o.id, s as never, undefined, TEST_ADMIN);
  return o;
}

test("only customers with a DELIVERED order for that product can review", async () => {
  assert.equal(await runAs(null, () => getReviewEligibility("p-standard")), "login_required");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");
  await assert.rejects(as("u1", () => submitReview("p-standard", good)), /Only customers who received/);
  // an undelivered (pending / cancelled / refunded) order does not qualify
  await as("u1", () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const pending = await as("u1", () => placeOrder(emptyCheckout));
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");
  await adminUpdateOrderStatus(pending.id, "CANCELLED", undefined, TEST_ADMIN);
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");
  // delivered, but a DIFFERENT product / a different customer's order
  await deliveredOrder("u2");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");
  await deliveredOrder("u1", "p-bundle");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");
  assert.equal(await as("u1", () => getReviewEligibility("p-bundle")), "can_review");
  await assert.rejects(runAs(null, () => submitReview("p-standard", good)), /sign in/i);
});

test("submit: stored as PENDING, hidden publicly, duplicate blocked (incl. concurrent)", async () => {
  await deliveredOrder("u1");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "can_review");
  const results = await Promise.allSettled([as("u1", () => submitReview("p-standard", good)), as("u1", () => submitReview("p-standard", good))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.rows("review").length, 1);
  const stored = db.rows("review")[0];
  assert.equal(stored.isApproved, false);
  assert.equal(stored.rejectedAt ?? null, null);
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "already_reviewed");
  await assert.rejects(as("u1", () => submitReview("p-standard", good)), /already reviewed/);
  // pending review is NOT visible on the product page
  assert.equal((await getProductBySlug("clay-vase"))!.reviews.length, 0);
});

test("moderation: approve shows it publicly, reject hides it and blocks resubmission", async () => {
  await deliveredOrder("u1");
  await as("u1", () => submitReview("p-standard", good));
  const id = db.rows("review")[0].id;
  assert.equal(await adminCountPendingReviews(), 1);

  await assert.rejects(runAs(null, () => moderateReviewAction(id, "approve")), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "u1" }, () => moderateReviewAction(id, "approve")), /FORBIDDEN/);
  assert.equal((await runAs("admin", () => moderateReviewAction(id, "bogus" as never))).success, false);
  assert.equal((await runAs("admin", () => moderateReviewAction("missing", "approve"))).success, false);

  assert.equal((await runAs("admin", () => moderateReviewAction(id, "approve"))).success, true);
  const page = (await getProductBySlug("clay-vase"))!;
  assert.equal(page.reviews.length, 1);
  assert.equal(page.reviews[0].reviewerName, "Nusrat J.");
  assert.deepEqual((await adminListReviews("approved")).items.map((r) => r.id), [id]);

  assert.equal((await runAs("admin", () => moderateReviewAction(id, "reject"))).success, true);
  assert.equal((await getProductBySlug("clay-vase"))!.reviews.length, 0);
  assert.deepEqual((await adminListReviews("rejected")).items.map((r) => r.id), [id]);
  assert.equal((await adminListReviews("pending")).items.length, 0);
  await assert.rejects(as("u1", () => submitReview("p-standard", good)), /already reviewed/); // can't resubmit after rejection
});

test("server-side validation of rating and content", async () => {
  await deliveredOrder("u1");
  for (const rating of [0, 6, 3.5, NaN, "5", null, undefined]) {
    await assert.rejects(as("u1", () => submitReview("p-standard", { ...good, rating: rating as never })), /rating/i, String(rating));
  }
  for (const body of ["", "short", "   ", 5, null, "x".repeat(2001)]) {
    await assert.rejects(as("u1", () => submitReview("p-standard", { ...good, body: body as never })), /./, String(body));
  }
  await assert.rejects(as("u1", () => submitReview("p-standard", { ...good, title: "t".repeat(101) })), /title/i);
  await assert.rejects(as("u1", () => submitReview("p-standard", { ...good, title: { a: 1 } as never })), /title/i);
  assert.equal(db.rows("review").length, 0);
  const v = validateReview({ rating: 4, title: "  Great\n\tvase  ", body: "Line one\r\n\r\n\r\n\r\nLine two \u0000ok" });
  assert.deepEqual(v, { ok: true, rating: 4, title: "Great vase", body: "Line one\n\nLine two ok" });
});

test("review text is stored as plain text and the actions return safe errors", async () => {
  await deliveredOrder("u1");
  const payload = '<script>alert(1)</script> nice <img src=x onerror=alert(1)>';
  const ok = await as("u1", () => submitReviewAction("p-standard", { rating: 5, body: payload }));
  assert.equal(ok.success, true);
  // stored verbatim as text (rendered via React escaping, never as HTML)
  assert.equal(db.rows("review")[0].body, payload);
  const bad = await as("u1", () => submitReviewAction("p-standard", { rating: 5, body: payload }));
  assert.equal(bad.success, false);
  assert.ok(!/prisma|P2002|Unique/i.test(JSON.stringify(bad)));
  assert.equal(await as("u1", () => getReviewEligibilityAction("p-standard")), "already_reviewed");
});
