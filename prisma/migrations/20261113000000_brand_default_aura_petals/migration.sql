-- Branding: the built-in store name is now "Gift Pacific". Additive/safe:
-- 1. new rows default to the new name;
-- 2. an existing settings row is renamed ONLY when it still holds the old built-in default, so any name an admin typed is untouched.
ALTER TABLE "StoreSettings" ALTER COLUMN "storeName" SET DEFAULT 'Gift Pacific';
UPDATE "StoreSettings" SET "storeName" = 'Gift Pacific' WHERE "storeName" = 'Gift Pacific';
