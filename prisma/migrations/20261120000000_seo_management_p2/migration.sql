-- P2 (SEO management). ADDITIVE ONLY: new nullable/defaulted columns and three new tables. No existing value is modified or dropped.
-- Rollback (manual, only if nothing depends on it): DROP TABLE "Redirect", "StaticPage", "PageSeo"; then DROP COLUMN each column added below.

ALTER TABLE "StoreSettings" ADD COLUMN "seoDefaultTitle" TEXT,
ADD COLUMN "seoOgTitle" TEXT,
ADD COLUMN "seoOgDescription" TEXT,
ADD COLUMN "seoTwitterCard" TEXT NOT NULL DEFAULT 'summary_large_image',
ADD COLUMN "seoCanonicalBaseUrl" TEXT,
ADD COLUMN "seoDefaultNoIndex" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "seoDefaultNoFollow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "seoRobotsExtra" TEXT,
ADD COLUMN "seoOrgSchemaEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "seoWebsiteSchemaEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Product" ADD COLUMN "seoCanonicalUrl" TEXT;

ALTER TABLE "Category" ADD COLUMN "seoImage" TEXT,
ADD COLUMN "seoCanonicalUrl" TEXT;

ALTER TABLE "Box" ADD COLUMN "seoImage" TEXT,
ADD COLUMN "seoNoIndex" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "seoCanonicalUrl" TEXT;

CREATE TABLE "PageSeo" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "canonicalUrl" TEXT,
    "ogTitle" TEXT,
    "ogDescription" TEXT,
    "ogImage" TEXT,
    "noIndex" BOOLEAN NOT NULL DEFAULT false,
    "noFollow" BOOLEAN NOT NULL DEFAULT false,
    "robotsDirectives" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageSeo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageSeo_key_key" ON "PageSeo"("key");

CREATE TABLE "StaticPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "systemKey" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "showInFooter" BOOLEAN NOT NULL DEFAULT false,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "canonicalUrl" TEXT,
    "ogImage" TEXT,
    "noIndex" BOOLEAN NOT NULL DEFAULT false,
    "noFollow" BOOLEAN NOT NULL DEFAULT false,
    "robotsDirectives" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaticPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaticPage_slug_key" ON "StaticPage"("slug");
CREATE UNIQUE INDEX "StaticPage_systemKey_key" ON "StaticPage"("systemKey");
CREATE INDEX "StaticPage_isPublished_sortOrder_idx" ON "StaticPage"("isPublished", "sortOrder");

CREATE TABLE "Redirect" (
    "id" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Redirect_fromPath_key" ON "Redirect"("fromPath");
CREATE INDEX "Redirect_isActive_idx" ON "Redirect"("isActive");
