-- P6: courier intelligence (customer delivery history by phone) + courier-history evidence policy.
-- ADDITIVE ONLY: five columns WITH SAFE DEFAULTS on "StoreSettings" and one new table. Nothing is altered, dropped, rewritten or backfilled.
-- Existing orders keep their stored trust snapshot untouched. The defaults are the conservative policy: no advance reduction until an admin enables it.
--
-- ROLLBACK (manual; the snapshots are a cache/history, nothing else depends on them):
--   DROP TABLE "CourierIntelligenceSnapshot";
--   ALTER TABLE "StoreSettings" DROP COLUMN "trustCreditUnverifiedPhone", DROP COLUMN "trustRewardEnabled", DROP COLUMN "trustMaxAgeSeconds",
--     DROP COLUMN "trustMinProviders", DROP COLUMN "trustMinSample";

ALTER TABLE "StoreSettings"
  ADD COLUMN "trustMinSample" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "trustMinProviders" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "trustMaxAgeSeconds" INTEGER NOT NULL DEFAULT 3600,
  ADD COLUMN "trustRewardEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "trustCreditUnverifiedPhone" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CourierIntelligenceSnapshot" (
    "id" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "phoneMasked" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "delivered" INTEGER,
    "cancelled" INTEGER,
    "returned" INTEGER,
    "failed" INTEGER,
    "total" INTEGER,
    "reportedDeliveryRate" DECIMAL(5,2),
    "reportedCancellationRate" DECIMAL(5,2),
    "fraudReports" INTEGER,
    "source" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierIntelligenceSnapshot_phoneHash_provider_checkedAt_key" ON "CourierIntelligenceSnapshot"("phoneHash", "provider", "checkedAt");
CREATE INDEX "CourierIntelligenceSnapshot_phoneHash_provider_checkedAt_idx" ON "CourierIntelligenceSnapshot"("phoneHash", "provider", "checkedAt");
CREATE INDEX "CourierIntelligenceSnapshot_provider_checkedAt_idx" ON "CourierIntelligenceSnapshot"("provider", "checkedAt");
CREATE INDEX "CourierIntelligenceSnapshot_checkedAt_idx" ON "CourierIntelligenceSnapshot"("checkedAt");
