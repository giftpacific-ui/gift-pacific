-- P3.1 tracking: GA4 Measurement Protocol identifiers + consent-withdrawal reference on the EXISTING "OrderAttribution" table.
-- ADDITIVE ONLY: four nullable columns and one index. No table is created, no column is altered or dropped, no data is rewritten.
-- ("TrackingEventLog"."destination" is already free TEXT, so the new 'GA4_MP' destination needs no schema change.)
-- Sorts after 20261122000000_tracking_p3.
--
-- Rollback (manual; loses the GA4 client ids and consent references only):
--   DROP INDEX "OrderAttribution_consentRef_idx";
--   ALTER TABLE "OrderAttribution" DROP COLUMN "gaClientId", DROP COLUMN "gaSessionId", DROP COLUMN "consentRef", DROP COLUMN "consentWithdrawnAt";

-- AlterTable
ALTER TABLE "OrderAttribution" ADD COLUMN     "gaClientId" TEXT,
ADD COLUMN     "gaSessionId" TEXT,
ADD COLUMN     "consentRef" TEXT,
ADD COLUMN     "consentWithdrawnAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OrderAttribution_consentRef_idx" ON "OrderAttribution"("consentRef");
