-- Procurement model: stock can never be negative; units accepted beyond stock are tracked separately.
ALTER TABLE "Product" ADD COLUMN "procurementPending" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "procurementLimit" INTEGER;
ALTER TABLE "Product" ADD COLUMN "backorderNote" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "procurementPending" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProductVariant" ADD COLUMN "procurementLimit" INTEGER;
ALTER TABLE "OrderItem" ADD COLUMN "procurementQty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "procurementReceivedQty" INTEGER NOT NULL DEFAULT 0;

-- Existing negative stock meant "units owed" under the old backorder behaviour. Preserve that meaning:
-- move the debt to procurementPending and floor stock at 0. (Old order lines do not carry procurementQty,
-- so review any previously backordered orders by hand: cancelling one of them returns its units to stock.)
UPDATE "Product" SET "procurementPending" = "procurementPending" + (-"stock"), "stock" = 0 WHERE "stock" < 0;
UPDATE "ProductVariant" SET "procurementPending" = "procurementPending" + (-"stock"), "stock" = 0 WHERE "stock" < 0;

ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_nonneg_check" CHECK ("stock" >= 0);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_stock_nonneg_check" CHECK ("stock" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_procurement_check" CHECK ("procurementPending" >= 0 AND ("procurementLimit" IS NULL OR "procurementLimit" >= 0));
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_procurement_check" CHECK ("procurementPending" >= 0 AND ("procurementLimit" IS NULL OR "procurementLimit" >= 0));
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_procurement_check" CHECK ("procurementQty" >= 0 AND "procurementReceivedQty" >= 0 AND "procurementReceivedQty" <= "procurementQty");

CREATE TABLE "ProcurementReceipt" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "allocatedToOrders" INTEGER NOT NULL,
    "addedToStock" INTEGER NOT NULL,
    "adminId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcurementReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProcurementReceipt_quantity_check" CHECK ("quantity" > 0 AND "allocatedToOrders" >= 0 AND "addedToStock" >= 0)
);
CREATE INDEX "ProcurementReceipt_productId_createdAt_idx" ON "ProcurementReceipt"("productId", "createdAt");
