ALTER TABLE "Payment" ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'FULL';
ALTER TABLE "Payment" ADD COLUMN "customerReference" TEXT;
ALTER TABLE "Payment" ADD COLUMN "verifiedById" TEXT;
ALTER TABLE "Payment" ADD COLUMN "verifiedAt" TIMESTAMP(3);
-- A wallet transaction id can be counted once only (NULLs are distinct, so unverified rows are unaffected).
CREATE UNIQUE INDEX "Payment_method_providerRef_key" ON "Payment"("method", "providerRef");

ALTER TABLE "Order" ADD COLUMN "advanceRequired" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "advancePaid" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "trustScore" INTEGER;
ALTER TABLE "Order" ADD COLUMN "trustSnapshot" JSONB;
ALTER TABLE "Order" ADD COLUMN "advanceWaivedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "advanceWaivedReason" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_advance_check" CHECK ("advanceRequired" >= 0 AND "advancePaid" >= 0 AND "advancePaid" <= "total" AND "advanceRequired" <= "total" AND ("trustScore" IS NULL OR "trustScore" BETWEEN 0 AND 100));

ALTER TABLE "StoreSettings" ADD COLUMN "advanceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreSettings" ADD COLUMN "advanceZones" "DeliveryZone"[] DEFAULT ARRAY['OUTSIDE_DHAKA']::"DeliveryZone"[];
ALTER TABLE "StoreSettings" ADD COLUMN "advanceStandardAmount" DECIMAL(10,2) NOT NULL DEFAULT 200;
ALTER TABLE "StoreSettings" ADD COLUMN "advanceReducedAmount" DECIMAL(10,2) NOT NULL DEFAULT 100;
ALTER TABLE "StoreSettings" ADD COLUMN "advanceZeroAtFullTrust" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreSettings" ADD COLUMN "trustLowBelow" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "StoreSettings" ADD COLUMN "trustReducedFrom" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "StoreSettings" ADD COLUMN "trustFullAt" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "StoreSettings" ADD COLUMN "advanceInstructions" TEXT;
ALTER TABLE "StoreSettings" ADD CONSTRAINT "StoreSettings_advance_check" CHECK (
  "advanceStandardAmount" >= 0 AND "advanceReducedAmount" >= 0 AND "advanceReducedAmount" <= "advanceStandardAmount"
  AND "trustLowBelow" BETWEEN 1 AND 100 AND "trustLowBelow" <= "trustReducedFrom" AND "trustReducedFrom" <= "trustFullAt" AND "trustFullAt" <= 100);
