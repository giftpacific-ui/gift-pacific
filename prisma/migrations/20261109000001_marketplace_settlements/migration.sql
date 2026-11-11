-- Marketplace payouts actually received, one row per payout entry (append-only).
CREATE TABLE "MarketplaceSettlement" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "receivedOn" DATE NOT NULL,
    "reference" TEXT,
    "idempotencyKey" TEXT,
    "note" TEXT,
    "legacyAssumed" BOOLEAN NOT NULL DEFAULT false,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketplaceSettlement_pkey" PRIMARY KEY ("id"),
    -- A payout entry is real money: strictly positive. (Corrections are made by fixing the order's cost lines, never by a negative payout.)
    CONSTRAINT "MarketplaceSettlement_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "MarketplaceSettlement_idempotencyKey_key" ON "MarketplaceSettlement"("idempotencyKey");
-- NULL references are distinct in PostgreSQL, so entries without a reference are guarded by the service (same amount + date) instead.
CREATE UNIQUE INDEX "MarketplaceSettlement_orderId_reference_key" ON "MarketplaceSettlement"("orderId", "reference");
CREATE INDEX "MarketplaceSettlement_orderId_idx" ON "MarketplaceSettlement"("orderId");
CREATE INDEX "MarketplaceSettlement_receivedOn_idx" ON "MarketplaceSettlement"("receivedOn");
ALTER TABLE "MarketplaceSettlement" ADD CONSTRAINT "MarketplaceSettlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACK-FILL. Before this migration an order was either PENDING or SETTLED and "SETTLED" meant "the payout arrived" with no amount.
-- For those orders we record ONE row equal to the expected payout (total - advance paid to us - commission/payment fee withheld, never below 0)
-- and flag it legacyAssumed = true, so the Accounts page tells the owner that this amount was assumed, not entered. Review and, where the real
-- payout differed, correct the order's cost lines. Orders that were never SETTLED are untouched (they stay receivables).
INSERT INTO "MarketplaceSettlement" ("id", "orderId", "amount", "receivedOn", "reference", "note", "legacyAssumed")
SELECT 'legacy_' || o."id", o."id",
       GREATEST(
         o."total" - LEAST(o."advancePaid", o."total")
         - COALESCE((SELECT SUM(c."amount") FROM "OrderCostLine" c WHERE c."orderId" = o."id" AND c."kind" IN ('MARKETPLACE_COMMISSION', 'PAYMENT_FEE')), 0),
         0),
       COALESCE(o."settledAt", o."createdAt")::date,
       NULL,
       'Back-filled from the old "settled" flag: the full expected payout was ASSUMED. Verify against the marketplace statement.',
       true
FROM "Order" o
WHERE o."settlementStatus" = 'SETTLED'
  AND GREATEST(
        o."total" - LEAST(o."advancePaid", o."total")
        - COALESCE((SELECT SUM(c."amount") FROM "OrderCostLine" c WHERE c."orderId" = o."id" AND c."kind" IN ('MARKETPLACE_COMMISSION', 'PAYMENT_FEE')), 0),
        0) > 0;
