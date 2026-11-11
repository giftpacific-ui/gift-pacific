-- Phase 7.1.3: separate refund lifecycle timestamps and uncertain-refund resolution.
-- Nullable columns are ADDED; the two UPDATEs below only fill those NEW columns for rows that already exist (no existing value changes).
ALTER TABLE "GatewayRefund" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "GatewayRefund" ADD COLUMN "providerConfirmedAt" TIMESTAMP(3);
ALTER TABLE "GatewayRefund" ADD COLUMN "accountingRecordedAt" TIMESTAMP(3);
ALTER TABLE "GatewayRefund" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "GatewayRefund" ADD COLUMN "resolvedById" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "resolutionNote" TEXT;

-- Safety: before this migration every refund request was sent right after the row was saved, so a refund that is still
-- PENDING may well have reached bKash. Treat every existing PENDING refund as UNCERTAIN (never "safe to send").
UPDATE "GatewayRefund" SET "submittedAt" = "createdAt" WHERE "status" = 'PENDING' AND "submittedAt" IS NULL;

-- A confirmed refund not yet in accounting keeps its true confirmation time (its row has not changed since it was confirmed).
UPDATE "GatewayRefund" SET "providerConfirmedAt" = "updatedAt" WHERE "status" = 'SUCCEEDED' AND "incidentId" IS NULL AND "providerConfirmedAt" IS NULL;
