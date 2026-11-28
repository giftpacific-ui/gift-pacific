-- Multi-provider courier management: honest per-courier connection state + a note on shipment-timeline entries.
-- ADDITIVE ONLY: one new table and one NULLable column. Nothing is altered, dropped, rewritten or backfilled.
-- "CourierShipmentEvent" stays append-only (its trigger guards UPDATE/DELETE; adding a column is unaffected).
--
-- ROLLBACK (manual; both are display-only data, nothing else depends on them):
--   DROP TABLE "CourierConnectionCheck";
--   ALTER TABLE "CourierShipmentEvent" DROP COLUMN "note";

ALTER TABLE "CourierShipmentEvent" ADD COLUMN "note" TEXT;

CREATE TABLE "CourierConnectionCheck" (
    "provider" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "failureKind" TEXT,
    "message" TEXT,
    "fingerprint" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "checkedById" TEXT,

    CONSTRAINT "CourierConnectionCheck_pkey" PRIMARY KEY ("provider")
);
