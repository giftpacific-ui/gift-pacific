-- Courier booking fields, review moderation, campaigns, stock-adjustment history.
--
-- SPECIAL HANDLING (read before deploying to a database that already has data):
--  * "Review_userId_productId_key" enforces one review per customer per
--    product. If duplicate (userId, productId) reviews already exist (the app
--    had no review-submission path before this release, so this can only come
--    from manual inserts), delete the extras first or this migration fails
--    loudly — it never deletes data on its own.
--  * ALTER TYPE ... ADD VALUE cannot be used in the same transaction as a
--    statement that uses the new value; nothing here does that.

-- AlterEnum
ALTER TYPE "BannerPlacement" ADD VALUE 'CAMPAIGN';
ALTER TYPE "BannerPlacement" ADD VALUE 'POPUP';

-- CreateEnum
CREATE TYPE "CourierBookingStatus" AS ENUM ('NOT_BOOKED', 'BOOKING', 'BOOKED', 'FAILED', 'UNCERTAIN', 'MANUAL');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "isCampaign" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "rejectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "courierProvider" TEXT,
ADD COLUMN     "courierConsignmentId" TEXT,
ADD COLUMN     "courierBookingStatus" "CourierBookingStatus" NOT NULL DEFAULT 'NOT_BOOKED',
ADD COLUMN     "courierBookingStartedAt" TIMESTAMP(3),
ADD COLUMN     "courierBookedAt" TIMESTAMP(3),
ADD COLUMN     "courierLastStatus" TEXT,
ADD COLUMN     "courierLastEventAt" TIMESTAMP(3),
ADD COLUMN     "courierLastError" TEXT;

-- Orders that already carry manually-entered courier details become MANUAL.
UPDATE "Order" SET "courierBookingStatus" = 'MANUAL'
WHERE "courierName" IS NOT NULL OR "trackingNumber" IS NOT NULL;

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "delta" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_userId_productId_key" ON "Review"("userId", "productId");

-- CreateIndex
CREATE INDEX "Review_isApproved_idx" ON "Review"("isApproved");

-- CreateIndex
CREATE INDEX "Order_courierProvider_courierConsignmentId_idx" ON "Order"("courierProvider", "courierConsignmentId");

-- CreateIndex
CREATE INDEX "StockAdjustment_productId_createdAt_idx" ON "StockAdjustment"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockAdjustment_variantId_idx" ON "StockAdjustment"("variantId");

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
