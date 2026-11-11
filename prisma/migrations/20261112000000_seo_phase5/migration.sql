-- Phase 5 (SEO). ADDITIVE ONLY: new nullable/defaulted columns and one new table. No existing value is modified.

ALTER TABLE "Product" ADD COLUMN "seoImage" TEXT;
ALTER TABLE "Product" ADD COLUMN "seoNoIndex" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Category" ADD COLUMN "seoNoIndex" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Collection" ADD COLUMN "metaTitle" TEXT;
ALTER TABLE "Collection" ADD COLUMN "metaDescription" TEXT;

CREATE TABLE "SlugRedirect" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "oldSlug" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlugRedirect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlugRedirect_entityType_oldSlug_key" ON "SlugRedirect"("entityType", "oldSlug");
CREATE INDEX "SlugRedirect_entityType_entityId_idx" ON "SlugRedirect"("entityType", "entityId");
