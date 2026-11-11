-- SEO keywords stored as a text[] (one element per tag). Additive and backward compatible.
ALTER TABLE "Product" ADD COLUMN "metaKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StoreSettings" ADD COLUMN "seoKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
