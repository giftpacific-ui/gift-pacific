ALTER TABLE "StoreSettings" ADD COLUMN "rewardEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreSettings" ADD COLUMN "rewardDeliveryPercent" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "StoreSettings" ADD COLUMN "rewardMinOrderAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "StoreSettings" ADD COLUMN "rewardMaxDiscount" DECIMAL(10,2);
ALTER TABLE "StoreSettings" ADD COLUMN "rewardValidityDays" INTEGER;
ALTER TABLE "StoreSettings" ADD COLUMN "rewardOncePerCustomer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreSettings" ADD COLUMN "rewardStackWithCoupon" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StoreSettings" ADD CONSTRAINT "StoreSettings_reward_check" CHECK ("rewardDeliveryPercent" BETWEEN 1 AND 100 AND "rewardMinOrderAmount" >= 0 AND ("rewardMaxDiscount" IS NULL OR "rewardMaxDiscount" >= 0) AND ("rewardValidityDays" IS NULL OR "rewardValidityDays" > 0));

ALTER TABLE "Order" ADD COLUMN "deliveryDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryDiscount_check" CHECK ("deliveryDiscount" >= 0);

CREATE TYPE "RewardStatus" AS ENUM ('AVAILABLE', 'USED', 'EXPIRED', 'REVOKED');
CREATE TABLE "CustomerReward" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "maxDiscount" DECIMAL(10,2),
    "minOrderAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT true,
    "status" "RewardStatus" NOT NULL DEFAULT 'AVAILABLE',
    "expiresAt" TIMESTAMP(3),
    "usedOrderId" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerReward_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerReward_percent_check" CHECK ("percent" BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX "CustomerReward_orderId_key" ON "CustomerReward"("orderId");
CREATE UNIQUE INDEX "CustomerReward_code_key" ON "CustomerReward"("code");
CREATE UNIQUE INDEX "CustomerReward_usedOrderId_key" ON "CustomerReward"("usedOrderId");
CREATE INDEX "CustomerReward_userId_status_idx" ON "CustomerReward"("userId", "status");
