-- Phase 7.1.1: link a confirmed gateway refund to the refund accounting record. ADDITIVE ONLY (one nullable column).
ALTER TABLE "GatewayRefund" ADD COLUMN "incidentId" TEXT;
