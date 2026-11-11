import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { getFeaturedReviews, getMyReviewForProduct, getMyReviews, getReviewEligibility, submitReview } from "@/server/services/review.service";
import { adminModerateReview } from "@/server/services/admin-review.service";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { getProductBySlug } from "@/server/services/product.service";

let db: FakeDb;
const as = <T,>(sub: string | null, fn: () => Promise<T>) => runAs(sub ? { sub } : null, fn);
const body = { rating: 5, title: "Lovely", body: "Beautifully made and arrived quickly, would buy again." };

function order(id: string, userId: string, status: string, productId = "p-standard") {
  db.insert("order", { id, orderNumber: `AP-${id}`, userId, status, confirmationToken: id, createdAt: new Date() });
  db.insert("orderItem", { id: `${id}-item`, orderId: id, productId, productName: "Clay Vase", unitPrice: 100, quantity: 1, lineTotal: 100 });
  return `${id}-item`;
}
const publicReviews = async () => (await as(null, () => getProductBySlug("clay-vase")))!.reviews;
const events = (reviewId: string) => db.rows("reviewModerationEvent").filter((e) => e.reviewId === reviewId).map((e) => e.action);
const reviewRow = () => db.rows("review")[0];
const approve = (id: string) => adminModerateReview(id, "approve", "admin-1");

beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db);
  for (const id of ["u1", "u2"]) db.insert("user", { id, name: id === "u1" ? "Nusrat Jahan" : "Other Person", email: `${id}@x.com`, role: "CUSTOMER", isActive: true });
});

test("only a customer with a DELIVERED order item can review; the review is tied to that item and starts private", async () => {
  assert.equal(await as(null, () => getReviewEligibility("p-standard")), "login_required");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");
  order("o-pending", "u1", "PENDING");
  order("o-shipped", "u1", "SHIPPED");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "not_purchased");        // not delivered yet
  await assert.rejects(as("u1", () => submitReview("p-standard", body)), /received this product/);
  const item = order("o-done", "u1", "DELIVERED");
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "can_review");
  assert.equal(await as("u2", () => getReviewEligibility("p-standard")), "not_purchased");        // someone else's order is not theirs
  assert.equal(await as("u1", () => getReviewEligibility("p-variant")), "not_purchased");         // a different product
  await as("u1", () => submitReview("p-standard", body));
  assert.equal(reviewRow().orderItemId, item);
  assert.equal(reviewRow().status, "PENDING");
  assert.equal(reviewRow().isApproved, false);
  assert.deepEqual(events(reviewRow().id), ["SUBMITTED"]);
});

test("duplicates are prevented: one review per product per customer, one per order item", async () => {
  order("o-1", "u1", "DELIVERED");
  await as("u1", () => submitReview("p-standard", body));
  assert.equal(await as("u1", () => getReviewEligibility("p-standard")), "already_reviewed");
  await assert.rejects(as("u1", () => submitReview("p-standard", body)), /already reviewed/);
  order("o-2", "u1", "DELIVERED");                                                                  // a second purchase does not allow a second review
  await assert.rejects(as("u1", () => submitReview("p-standard", body)), /already reviewed/);
  assert.equal(db.rows("review").length, 1);
});

test("a review is private until approved: not public, but its author can always see it", async () => {
  order("o-1", "u1", "DELIVERED");
  await as("u1", () => submitReview("p-standard", body));
  assert.deepEqual(await publicReviews(), []);
  assert.equal((await getFeaturedReviews()).length, 0);
  const mine = await as("u1", () => getMyReviewForProduct("p-standard"));
  assert.equal(mine?.status, "PENDING");
  assert.match(mine!.label, /only you can see/);
  assert.equal(await as("u2", () => getMyReviewForProduct("p-standard")), null);                   // never someone else's
  assert.equal((await as("u2", () => getMyReviews())).length, 0);
});

test("approve publishes; hide removes it from the public but not from its author; unhide restores; every step is in the history", async () => {
  order("o-1", "u1", "DELIVERED");
  await as("u1", () => submitReview("p-standard", body));
  const id = reviewRow().id;
  await approve(id);
  assert.equal((await publicReviews()).length, 1);
  assert.equal((await getFeaturedReviews()).length, 1);
  await adminModerateReview(id, "hide", "admin-1", "off topic");
  assert.deepEqual(await publicReviews(), []);
  assert.equal((await getFeaturedReviews()).length, 0);
  const hidden = await as("u1", () => getMyReviewForProduct("p-standard"));
  assert.equal(hidden?.status, "HIDDEN");
  assert.equal(hidden?.body, body.body);                                                            // the author still sees their text
  await adminModerateReview(id, "unhide", "admin-1");
  assert.equal((await publicReviews()).length, 1);
  await adminModerateReview(id, "reject", "admin-1");
  assert.deepEqual(await publicReviews(), []);
  assert.deepEqual(events(id), ["SUBMITTED", "APPROVE", "HIDE", "UNHIDE", "REJECT"]);
  assert.equal(db.rows("reviewModerationEvent").find((e) => e.action === "HIDE")!.note, "off topic");
  assert.equal(db.rows("reviewModerationEvent").find((e) => e.action === "HIDE")!.actorId, "admin-1");
});

test("decisions that do not apply to the current state are refused and change nothing", async () => {
  order("o-1", "u1", "DELIVERED");
  await as("u1", () => submitReview("p-standard", body));
  const id = reviewRow().id;
  await assert.rejects(adminModerateReview(id, "hide"), /does not apply/);                          // cannot hide a pending review
  await assert.rejects(adminModerateReview(id, "unhide"), /does not apply/);
  await approve(id);
  await assert.rejects(approve(id), /does not apply/);
  await assert.rejects(adminModerateReview(id, "bogus" as never), /Invalid decision/);
  await assert.rejects(adminModerateReview("missing", "approve"), /not found/);
  assert.deepEqual(events(id), ["SUBMITTED", "APPROVE"]);
});

test("REFUND: eligibility is revoked -> the approved review is unpublished automatically; it returns if the order is delivered again", async () => {
  order("o-1", "u1", "DELIVERED");
  await as("u1", () => submitReview("p-standard", body));
  await approve(reviewRow().id);
  assert.equal((await publicReviews()).length, 1);

  await as("admin", () => adminUpdateOrderStatus("o-1", "REFUND_REQUESTED", undefined, TEST_ADMIN));
  assert.deepEqual(await publicReviews(), []);                                                      // gone from the product page...
  assert.equal((await getFeaturedReviews()).length, 0);                                             // ...and the homepage
  const mine = await as("u1", () => getMyReviewForProduct("p-standard"));
  assert.match(mine!.label, /Unpublished because the order was returned or refunded/);
  assert.equal(mine!.body, body.body);                                                              // the author keeps access

  await as("admin", () => adminUpdateOrderStatus("o-1", "DELIVERED", undefined, TEST_ADMIN));                              // refund request rejected
  assert.equal((await publicReviews()).length, 1);
  await as("admin", () => adminUpdateOrderStatus("o-1", "REFUND_REQUESTED", undefined, TEST_ADMIN));
  await as("admin", () => adminUpdateOrderStatus("o-1", "REFUNDED", undefined, TEST_ADMIN));
  assert.deepEqual(await publicReviews(), []);                                                      // refunded: stays unpublished
  assert.deepEqual(events(reviewRow().id), ["SUBMITTED", "APPROVE", "AUTO_UNPUBLISHED", "AUTO_REPUBLISHED", "AUTO_UNPUBLISHED"]);
  assert.equal(reviewRow().status, "APPROVED");                                                     // moderation state itself is untouched
});

test("public review payloads never expose order, customer or moderation details", async () => {
  order("o-1", "u1", "DELIVERED");
  await as("u1", () => submitReview("p-standard", body));
  await approve(reviewRow().id);
  const json = JSON.stringify([await publicReviews(), await getFeaturedReviews()]);
  for (const w of ["AP-o-1", "orderItem", "u1@x.com", "o-1", "adminNote", "admin-1", "SUBMITTED", "Nusrat Jahan"]) assert.ok(!json.includes(w), `leaked ${w}`);
  assert.match(json, /Nusrat J\./);
});

test("legacy approved reviews without an order item (pre-migration) stay public (grandfathered)", async () => {
  db.insert("review", { id: "legacy", productId: "p-standard", userId: "u2", rating: 5, title: "Old", body: "An older review that predates order-item links.", status: "APPROVED", isApproved: true, orderItemId: null });
  assert.equal((await publicReviews()).length, 1);
});
