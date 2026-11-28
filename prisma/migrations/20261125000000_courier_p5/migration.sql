-- P5: courier sync, uncertain-booking recovery and COD discrepancy resolution.
-- ADDITIVE ONLY: five NULLable columns + one index on "Order", two new tables, two append-only triggers.
-- Nothing is altered, dropped, rewritten or backfilled; existing orders keep every current value and NULL in the new columns means "not known yet".
--
-- ROLLBACK (manual, only if no P5 data must be kept):
--   DROP TRIGGER "CourierCodResolution_append_only" ON "CourierCodResolution";
--   DROP TRIGGER "CourierShipmentEvent_append_only" ON "CourierShipmentEvent";
--   DROP FUNCTION "courier_p5_append_only"();
--   DROP TABLE "CourierCodResolution"; DROP TABLE "CourierShipmentEvent";
--   DROP INDEX "Order_courierBookingStatus_courierLastEventAt_idx";
--   ALTER TABLE "Order" DROP COLUMN "courierSyncLeaseUntil", DROP COLUMN "courierRemoteConfirmedAt", DROP COLUMN "courierCodAmount",
--     DROP COLUMN "courierLastSyncAt", DROP COLUMN "courierEventAt";

ALTER TABLE "Order"
  ADD COLUMN "courierEventAt" TIMESTAMP(3),
  ADD COLUMN "courierLastSyncAt" TIMESTAMP(3),
  ADD COLUMN "courierCodAmount" DECIMAL(10,2),
  ADD COLUMN "courierRemoteConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "courierSyncLeaseUntil" TIMESTAMP(3);

CREATE INDEX "Order_courierBookingStatus_courierLastEventAt_idx" ON "Order"("courierBookingStatus", "courierLastEventAt");

CREATE TABLE "CourierShipmentEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "consignmentId" TEXT,
    "source" TEXT NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "mappedEvent" TEXT NOT NULL,
    "providerEventAt" TIMESTAMP(3),
    "codAmount" DECIMAL(10,2),
    "outcome" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- NULL dedupeKeys (events without a trusted provider time) never collide: PostgreSQL treats NULLs as distinct in a unique index.
CREATE UNIQUE INDEX "CourierShipmentEvent_dedupeKey_key" ON "CourierShipmentEvent"("dedupeKey");
CREATE INDEX "CourierShipmentEvent_orderId_createdAt_idx" ON "CourierShipmentEvent"("orderId", "createdAt");
ALTER TABLE "CourierShipmentEvent" ADD CONSTRAINT "CourierShipmentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CourierCodResolution" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "flagCode" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierCodResolution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierCodResolution_orderId_flagCode_amountCents_key" ON "CourierCodResolution"("orderId", "flagCode", "amountCents");
CREATE INDEX "CourierCodResolution_orderId_idx" ON "CourierCodResolution"("orderId");
ALTER TABLE "CourierCodResolution" ADD CONSTRAINT "CourierCodResolution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Both tables are history: corrected by adding rows, never by rewriting them (same pattern as "CourierCodEntry").
CREATE OR REPLACE FUNCTION "courier_p5_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: add a new row instead of changing history', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CourierShipmentEvent_append_only"
BEFORE UPDATE OR DELETE ON "CourierShipmentEvent"
FOR EACH ROW EXECUTE FUNCTION "courier_p5_append_only"();

CREATE TRIGGER "CourierCodResolution_append_only"
BEFORE UPDATE OR DELETE ON "CourierCodResolution"
FOR EACH ROW EXECUTE FUNCTION "courier_p5_append_only"();
