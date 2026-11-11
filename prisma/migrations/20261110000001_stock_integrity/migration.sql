-- Phase 2: inventory / stock-movement integrity. ADDITIVE ONLY: new columns, indexes, constraints and a counters back-fill.
-- NO stock quantity, procurementPending, order status or money value is changed by this migration (see docs/inventory.md).

-- 1. Per-line physical accounting. out = stockDeducted + procurementReceivedQty; returned + discarded may never exceed it.
ALTER TABLE "OrderItem" ADD COLUMN "stockReturnedQty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "stockDiscardedQty" INTEGER NOT NULL DEFAULT 0;

-- 2. Combo components can now be backordered too (their pending units were previously counted nowhere) and returned/discarded.
ALTER TABLE "OrderItemComponent" ADD COLUMN "procurementQty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItemComponent" ADD COLUMN "procurementReceivedQty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItemComponent" ADD COLUMN "stockReturnedQty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItemComponent" ADD COLUMN "stockDiscardedQty" INTEGER NOT NULL DEFAULT 0;

-- 3. Incidents: idempotency key (a retried submit returns the first record) + lookup index.
ALTER TABLE "FinancialIncident" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "FinancialIncident_idempotencyKey_key" ON "FinancialIncident"("idempotencyKey");
CREATE INDEX "FinancialIncident_orderItemId_idx" ON "FinancialIncident"("orderItemId");

-- 4. Stock ledger: why (kind), which record (sourceType/sourceId), and a unique idempotency key. NULL on historic rows.
ALTER TABLE "StockAdjustment" ADD COLUMN "kind" TEXT;
ALTER TABLE "StockAdjustment" ADD COLUMN "sourceType" TEXT;
ALTER TABLE "StockAdjustment" ADD COLUMN "sourceId" TEXT;
ALTER TABLE "StockAdjustment" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "StockAdjustment_idempotencyKey_key" ON "StockAdjustment"("idempotencyKey");
CREATE INDEX "StockAdjustment_sourceType_sourceId_idx" ON "StockAdjustment"("sourceType", "sourceId");

-- 4b. Procurement receipts: idempotency key (a retried receipt must not allocate the same goods to waiting orders twice).
ALTER TABLE "ProcurementReceipt" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "ProcurementReceipt_idempotencyKey_key" ON "ProcurementReceipt"("idempotencyKey");

-- 5. BACK-FILL of the new counters from facts that already exist (nothing is invented, nothing is clamped silently:
--    where history disagrees with the new invariant the counter is capped at `out` and the line is listed by the reconciliation preview).
--    a) a line released by cancel/refund gave back exactly stockDeducted + procurementReceivedQty (that was the old release formula);
--    b) a line not released has gone back only through RESTOCK incidents.
UPDATE "OrderItem" oi
SET "stockReturnedQty" = LEAST(
      oi."stockDeducted" + oi."procurementReceivedQty",
      CASE WHEN oi."stockRestoredAt" IS NOT NULL
           THEN oi."stockDeducted" + oi."procurementReceivedQty"
           ELSE COALESCE((SELECT SUM(fi."quantity") FROM "FinancialIncident" fi WHERE fi."orderItemId" = oi."id" AND fi."stockEffect" = 'RESTOCK'), 0)
      END)
WHERE oi."stockRestoredAt" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "FinancialIncident" fi WHERE fi."orderItemId" = oi."id" AND fi."stockEffect" = 'RESTOCK');

--    c) a released COMPONENTS-policy combo line counts in whole combos: all of them went back.
UPDATE "OrderItem" oi
SET "stockReturnedQty" = oi."quantity"
WHERE oi."stockRestoredAt" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "OrderItemComponent" c WHERE c."orderItemId" = oi."id" AND c."stockDeducted" > 0);

--    d) released components gave back exactly stockDeducted.
UPDATE "OrderItemComponent" SET "stockReturnedQty" = "stockDeducted" WHERE "stockRestoredAt" IS NOT NULL;

-- 6. Constraints (added after the back-fill so existing rows are validated against what was just derived).
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_stock_counters_check"
  CHECK ("stockReturnedQty" >= 0 AND "stockDiscardedQty" >= 0
         AND "stockReturnedQty" + "stockDiscardedQty" <= GREATEST("stockDeducted" + "procurementReceivedQty", "quantity"));
ALTER TABLE "OrderItemComponent" ADD CONSTRAINT "OrderItemComponent_stock_counters_check"
  CHECK ("procurementQty" >= 0 AND "procurementReceivedQty" >= 0 AND "procurementReceivedQty" <= "procurementQty"
         AND "stockReturnedQty" >= 0 AND "stockDiscardedQty" >= 0
         AND "stockReturnedQty" + "stockDiscardedQty" <= "stockDeducted" + "procurementReceivedQty");
