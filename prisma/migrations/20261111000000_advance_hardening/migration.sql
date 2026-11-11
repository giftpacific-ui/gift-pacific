-- Phase 3: advance payment / trust policy hardening. ADDITIVE ONLY. No payment, order status, stock or money value is modified.

-- 1. Waiver timestamp + low-trust review gate (decided at checkout, stored per order).
ALTER TABLE "Order" ADD COLUMN "advanceWaivedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "trustReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "trustReviewedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "trustReviewedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "trustReviewNote" TEXT;

-- Back-fill, deliberately narrow: only orders that are STILL PENDING (so the gate can still be applied) and whose own stored snapshot says
-- "needs review" are marked. Orders already confirmed/shipped/closed keep trustReviewRequired = false: their historical decision is not rewritten
-- and no live order is suddenly blocked half-way through fulfilment.
UPDATE "Order" SET "trustReviewRequired" = true
WHERE "status" = 'PENDING' AND ("trustSnapshot" ->> 'needsReview') = 'true';
-- Waivers recorded before this migration have no timestamp (advanceWaivedAt stays NULL); from now on every waiver also writes an AdminAuditEvent.

-- 2. Policy switches / provenance on the singleton settings row.
ALTER TABLE "StoreSettings" ADD COLUMN "trustReviewEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StoreSettings" ADD COLUMN "advancePolicyUpdatedAt" TIMESTAMP(3);
ALTER TABLE "StoreSettings" ADD COLUMN "advancePolicyUpdatedById" TEXT;

-- 3. Staff audit trail.
CREATE TABLE "AdminAuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAuditEvent_entityType_entityId_idx" ON "AdminAuditEvent"("entityType", "entityId");
CREATE INDEX "AdminAuditEvent_actorId_idx" ON "AdminAuditEvent"("actorId");
CREATE INDEX "AdminAuditEvent_createdAt_idx" ON "AdminAuditEvent"("createdAt");

-- 4. Money sanity, added NOT VALID so PostgreSQL does NOT scan or reject existing rows (no migration failure on odd historic data); it is enforced
--    for every new row and every later UPDATE of a row. Pre-flight (docs/advance-payments.md): count rows that would violate it.
ALTER TABLE "Order" ADD CONSTRAINT "Order_advance_amounts_check"
  CHECK ("advanceRequired" >= 0 AND "advancePaid" >= 0 AND "advanceRequired" <= "total" AND "advancePaid" <= "total") NOT VALID;
