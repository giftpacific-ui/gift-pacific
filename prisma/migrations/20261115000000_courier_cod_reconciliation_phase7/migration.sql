-- Phase 7: courier COD reconciliation. ADDITIVE ONLY (one enum, one table, one trigger). No existing data is touched.

CREATE TYPE "CourierCodEntryKind" AS ENUM ('COLLECTION_REPORTED', 'FEE_DEDUCTED', 'SETTLEMENT_RECEIVED', 'ADJUSTMENT');

CREATE TABLE "CourierCodEntry" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "CourierCodEntryKind" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "provider" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierCodEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourierCodEntry_orderId_idx" ON "CourierCodEntry"("orderId");
CREATE INDEX "CourierCodEntry_kind_createdAt_idx" ON "CourierCodEntry"("kind", "createdAt");

ALTER TABLE "CourierCodEntry" ADD CONSTRAINT "CourierCodEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: history is corrected with a new ADJUSTMENT row, never rewritten.
CREATE OR REPLACE FUNCTION "courier_cod_entry_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CourierCodEntry is append-only: add an ADJUSTMENT entry instead of changing history';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CourierCodEntry_append_only"
BEFORE UPDATE OR DELETE ON "CourierCodEntry"
FOR EACH ROW EXECUTE FUNCTION "courier_cod_entry_append_only"();
