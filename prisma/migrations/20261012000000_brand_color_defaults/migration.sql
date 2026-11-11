-- Storefront redesign: new default theme colors (burgundy-rose / warm paper).
--
-- ONLY the column defaults change. No existing row is modified — a store's
-- stored colors are left exactly as they are. (The application treats the two
-- OLD default values, #829265 and #f6f1ea, as "not customised" so existing
-- stores pick up the new design; see src/lib/theme.ts. Any other stored color
-- is respected as a deliberate choice.)

-- AlterTable
ALTER TABLE "StoreSettings" ALTER COLUMN "primaryColor" SET DEFAULT '#A63A5B',
ALTER COLUMN "secondaryColor" SET DEFAULT '#F1E5D6';
