-- P7.2: incomplete checkout recovery.
-- ADDITIVE ONLY: one enum, one new table, indexes and foreign keys. No existing table or row is altered.
--
-- ROLLBACK (manual; the table only holds saved checkout progress):
--   DROP TABLE "IncompleteCheckout";
--   DROP TYPE "IncompleteCheckoutStatus";

CREATE TYPE "IncompleteCheckoutStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'EXPIRED');

CREATE TABLE "IncompleteCheckout" (
    "id" TEXT NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "userId" TEXT,
    "status" "IncompleteCheckoutStatus" NOT NULL DEFAULT 'ACTIVE',
    "email" TEXT,
    "phone" TEXT,
    "phoneNorm" TEXT,
    "customerName" TEXT,
    "shippingAddress" JSONB,
    "deliveryZone" "DeliveryZone",
    "couponCode" TEXT,
    "items" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "estimatedTotal" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "checkoutKey" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncompleteCheckout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IncompleteCheckout_orderId_key" ON "IncompleteCheckout"("orderId");
CREATE INDEX "IncompleteCheckout_status_lastActivityAt_idx" ON "IncompleteCheckout"("status", "lastActivityAt");
CREATE INDEX "IncompleteCheckout_ownerKey_status_idx" ON "IncompleteCheckout"("ownerKey", "status");
CREATE INDEX "IncompleteCheckout_userId_idx" ON "IncompleteCheckout"("userId");
CREATE INDEX "IncompleteCheckout_phoneNorm_idx" ON "IncompleteCheckout"("phoneNorm");
CREATE INDEX "IncompleteCheckout_email_idx" ON "IncompleteCheckout"("email");

-- De-duplication: at most ONE active record per visitor. (Partial index: Prisma cannot express it in schema.prisma, so
-- `prisma migrate diff` will list it as drift; keep it.)
CREATE UNIQUE INDEX "IncompleteCheckout_ownerKey_active_key" ON "IncompleteCheckout"("ownerKey") WHERE "status" = 'ACTIVE';

ALTER TABLE "IncompleteCheckout" ADD CONSTRAINT "IncompleteCheckout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncompleteCheckout" ADD CONSTRAINT "IncompleteCheckout_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
