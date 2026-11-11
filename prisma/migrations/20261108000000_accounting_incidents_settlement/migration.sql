CREATE TYPE "SettlementStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SETTLED');
CREATE TYPE "IncidentKind" AS ENUM ('DAMAGED_BEFORE_DISPATCH', 'DAMAGED_IN_PACKAGING', 'DAMAGED_BOX', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_RETURN', 'FAILED_DELIVERY', 'REFUND', 'COURIER_RETURN_FEE', 'UNSELLABLE_WRITE_OFF', 'OTHER');
CREATE TYPE "IncidentStockEffect" AS ENUM ('NONE', 'RESTOCK', 'WRITE_OFF');

ALTER TABLE "Order" ADD COLUMN "settlementStatus" "SettlementStatus" NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE "Order" ADD COLUMN "settledAt" TIMESTAMP(3);
-- Existing marketplace orders: payout status was never tracked. Mark them PENDING so they show as receivables until settled.
UPDATE "Order" o SET "settlementStatus" = 'PENDING' FROM "SalesChannel" c WHERE o."channelId" = c.id AND c.kind = 'MARKETPLACE' AND o."status" NOT IN ('CANCELLED', 'REFUNDED', 'FAILED_DELIVERY');
CREATE INDEX "Order_settlementStatus_idx" ON "Order"("settlementStatus");

ALTER TABLE "ProcurementReceipt" ADD COLUMN "totalCost" DECIMAL(10,2);
ALTER TABLE "ProcurementReceipt" ADD CONSTRAINT "ProcurementReceipt_cost_check" CHECK ("totalCost" IS NULL OR "totalCost" >= 0);

ALTER TABLE "Category" ADD COLUMN "metaTitle" TEXT;
ALTER TABLE "Category" ADD COLUMN "metaDescription" TEXT;
ALTER TABLE "Category" ADD COLUMN "metaKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "FinancialIncident" (
    "id" TEXT NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "stockEffect" "IncidentStockEffect" NOT NULL DEFAULT 'NONE',
    "lossAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "refundAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "courierFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialIncident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FinancialIncident_amounts_check" CHECK ("lossAmount" >= 0 AND "refundAmount" >= 0 AND "courierFee" >= 0 AND "quantity" >= 0),
    -- Restocked goods are not a loss: prevents the same item being counted as both.
    CONSTRAINT "FinancialIncident_restock_noloss_check" CHECK ("stockEffect" <> 'RESTOCK' OR "lossAmount" = 0)
);
CREATE INDEX "FinancialIncident_occurredOn_idx" ON "FinancialIncident"("occurredOn");
CREATE INDEX "FinancialIncident_orderId_idx" ON "FinancialIncident"("orderId");
