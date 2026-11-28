-- One consignment belongs to exactly one order: a unique index on (courierProvider, courierConsignmentId).
-- ADDITIVE ONLY: one index. No column, row or existing index is altered or dropped.
--
-- PostgreSQL treats NULLs as distinct in a unique index, so orders that were never booked (both columns NULL, or no consignment id yet)
-- never conflict with each other. Only two orders holding the SAME consignment of the SAME courier are refused.
--
-- SAFE ON EXISTING DATA: if duplicate pairs already exist, the index is NOT created (a failed migration would block the deploy). A NOTICE says
-- so; resolve the duplicates (the application never creates them), then run the CREATE UNIQUE INDEX statement below by hand. The application
-- enforces the same rule in code either way, so the index is defence in depth against a race.
--
-- ROLLBACK (manual; the application keeps working, its own check still applies):
--   DROP INDEX IF EXISTS "Order_courierProvider_courierConsignmentId_key";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order"
    WHERE "courierProvider" IS NOT NULL AND "courierConsignmentId" IS NOT NULL
    GROUP BY "courierProvider", "courierConsignmentId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Index Order_courierProvider_courierConsignmentId_key was NOT created: duplicate (courierProvider, courierConsignmentId) pairs exist. Resolve them, then run: CREATE UNIQUE INDEX "Order_courierProvider_courierConsignmentId_key" ON "Order"("courierProvider", "courierConsignmentId");';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "Order_courierProvider_courierConsignmentId_key" ON "Order"("courierProvider", "courierConsignmentId");
  END IF;
END
$$;
