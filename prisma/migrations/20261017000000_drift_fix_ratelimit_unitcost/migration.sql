-- 1) Schema/migration drift: StockAdjustment.createdById was declared as a relation to
--    User in schema.prisma but no migration ever created the foreign key or its index.
--    Orphan ids (a deleted user) are cleared first so the constraint can be added.
UPDATE "StockAdjustment" SET "createdById" = NULL
WHERE "createdById" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "StockAdjustment"."createdById");

CREATE INDEX "StockAdjustment_createdById_idx" ON "StockAdjustment"("createdById");

ALTER TABLE "StockAdjustment"
  ADD CONSTRAINT "StockAdjustment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Cost of one unit at the time of the order (NULL = unknown). History before this
--    migration cannot be reconstructed, so existing rows stay NULL.
ALTER TABLE "OrderItem" ADD COLUMN "unitCost" DECIMAL(10,2);

-- 3) Fixed-window request counter used to throttle login, registration, password reset,
--    contact and review submissions. Keys are hashes; no raw IP or credential is stored.
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key","windowStart")
);

CREATE INDEX "RateLimitBucket_windowStart_idx" ON "RateLimitBucket"("windowStart");
