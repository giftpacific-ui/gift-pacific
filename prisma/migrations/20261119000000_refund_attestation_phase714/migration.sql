-- Phase 7.1.4: evidence + optional second-admin approval for manual refund attestations. ADDITIVE ONLY (nullable columns).
ALTER TABLE "GatewayRefund" ADD COLUMN "resolutionEvidence" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedOutcome" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedTrxId" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedConfirmedOn" TIMESTAMP(3);
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedEvidence" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedNote" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedById" TEXT;
ALTER TABLE "GatewayRefund" ADD COLUMN "proposedAt" TIMESTAMP(3);
