-- Follow-up to 20261120000000_seo_management_p2 (that migration is left untouched: it may already be applied).
-- schema.prisma declares PageSeo.keywords and StaticPage.seoKeywords as required lists (`String[] @default([])`), but the P2
-- migration created them as nullable `TEXT[]`. Align the database with the schema.
-- Safe for existing rows and idempotent: NULLs are replaced by an empty array FIRST, then the default and NOT NULL are (re)applied.
-- No rows are deleted and no non-NULL value is changed. Rollback: ALTER COLUMN ... DROP NOT NULL on both columns.

UPDATE "PageSeo" SET "keywords" = ARRAY[]::TEXT[] WHERE "keywords" IS NULL;
ALTER TABLE "PageSeo" ALTER COLUMN "keywords" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PageSeo" ALTER COLUMN "keywords" SET NOT NULL;

UPDATE "StaticPage" SET "seoKeywords" = ARRAY[]::TEXT[] WHERE "seoKeywords" IS NULL;
ALTER TABLE "StaticPage" ALTER COLUMN "seoKeywords" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaticPage" ALTER COLUMN "seoKeywords" SET NOT NULL;
