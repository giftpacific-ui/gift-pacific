-- P4 fraud prevention & order protection.
-- ADDITIVE ONLY: four enums, nullable / defaulted columns on "Order" and "StoreSettings", two new tables, indexes and foreign keys.
-- No existing column is altered or dropped and no existing row is rewritten (new "Order" columns are NULL, "riskReviewRequired" defaults to false).
-- Sorts after 20261123000000_tracking_p31.
--
-- Rollback (manual; loses all risk assessments, block/allow lists and review decisions):
--   DROP TABLE "OrderRiskAssessment"; DROP TABLE "RiskListEntry";
--   DROP INDEX "Order_checkoutKey_key", "Order_phoneNorm_idx", "Order_emailNorm_idx", "Order_addressKey_idx", "Order_riskLevel_riskReviewRequired_idx";
--   ALTER TABLE "Order" DROP COLUMN "phoneNorm", DROP COLUMN "emailNorm", DROP COLUMN "addressKey", DROP COLUMN "checkoutKey", DROP COLUMN "riskScore",
--     DROP COLUMN "riskLevel", DROP COLUMN "riskAssessedAt", DROP COLUMN "riskAssessmentId", DROP COLUMN "riskReviewRequired", DROP COLUMN "riskReviewDecision",
--     DROP COLUMN "riskReviewedLevel", DROP COLUMN "riskReviewedById", DROP COLUMN "riskReviewedAt", DROP COLUMN "riskReviewReason";
--   ALTER TABLE "StoreSettings" DROP COLUMN "fraudPolicy";
--   DROP TYPE "RiskLevel"; DROP TYPE "RiskReviewDecision"; DROP TYPE "RiskListType"; DROP TYPE "RiskListKind";

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiskListType" AS ENUM ('BLOCK', 'ALLOW');

-- CreateEnum
CREATE TYPE "RiskListKind" AS ENUM ('PHONE', 'EMAIL', 'IP');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "phoneNorm" TEXT,
ADD COLUMN     "emailNorm" TEXT,
ADD COLUMN     "addressKey" TEXT,
ADD COLUMN     "checkoutKey" TEXT,
ADD COLUMN     "riskScore" INTEGER,
ADD COLUMN     "riskLevel" "RiskLevel",
ADD COLUMN     "riskAssessedAt" TIMESTAMP(3),
ADD COLUMN     "riskAssessmentId" TEXT,
ADD COLUMN     "riskReviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "riskReviewDecision" "RiskReviewDecision",
ADD COLUMN     "riskReviewedLevel" "RiskLevel",
ADD COLUMN     "riskReviewedById" TEXT,
ADD COLUMN     "riskReviewedAt" TIMESTAMP(3),
ADD COLUMN     "riskReviewReason" TEXT;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "fraudPolicy" JSONB;

-- CreateTable
CREATE TABLE "OrderRiskAssessment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" "RiskLevel" NOT NULL,
    "trigger" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "clientIp" TEXT,
    "calculatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskListEntry" (
    "id" TEXT NOT NULL,
    "listType" "RiskListType" NOT NULL,
    "kind" "RiskListKind" NOT NULL,
    "value" TEXT NOT NULL,
    "displayValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledById" TEXT,
    "disabledReason" TEXT,

    CONSTRAINT "RiskListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderRiskAssessment_orderId_createdAt_idx" ON "OrderRiskAssessment"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderRiskAssessment_clientIp_createdAt_idx" ON "OrderRiskAssessment"("clientIp", "createdAt");

-- CreateIndex
CREATE INDEX "OrderRiskAssessment_level_createdAt_idx" ON "OrderRiskAssessment"("level", "createdAt");

-- CreateIndex
CREATE INDEX "RiskListEntry_kind_value_idx" ON "RiskListEntry"("kind", "value");

-- CreateIndex
CREATE INDEX "RiskListEntry_listType_disabledAt_idx" ON "RiskListEntry"("listType", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_checkoutKey_key" ON "Order"("checkoutKey");

-- CreateIndex
CREATE INDEX "Order_phoneNorm_idx" ON "Order"("phoneNorm");

-- CreateIndex
CREATE INDEX "Order_emailNorm_idx" ON "Order"("emailNorm");

-- CreateIndex
CREATE INDEX "Order_addressKey_idx" ON "Order"("addressKey");

-- CreateIndex
CREATE INDEX "Order_riskLevel_riskReviewRequired_idx" ON "Order"("riskLevel", "riskReviewRequired");

-- AddForeignKey
ALTER TABLE "OrderRiskAssessment" ADD CONSTRAINT "OrderRiskAssessment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
