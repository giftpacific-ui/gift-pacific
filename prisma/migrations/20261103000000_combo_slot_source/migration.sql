CREATE TYPE "ComboSlotSource" AS ENUM ('MANUAL', 'CATALOG', 'BOXES');
ALTER TABLE "ComboSlot" ADD COLUMN "source" "ComboSlotSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "ComboSlot" ADD COLUMN "categoryId" TEXT;
-- A category filter only makes sense for catalog slots.
ALTER TABLE "ComboSlot" ADD CONSTRAINT "ComboSlot_category_source_check" CHECK ("categoryId" IS NULL OR "source" = 'CATALOG');
