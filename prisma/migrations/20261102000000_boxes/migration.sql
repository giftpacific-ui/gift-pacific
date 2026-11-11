CREATE TABLE "Box" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "imagePublicId" TEXT,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "productId" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Box_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Box_price_check" CHECK ("price" >= 0)
);
CREATE UNIQUE INDEX "Box_slug_key" ON "Box"("slug");
CREATE UNIQUE INDEX "Box_productId_key" ON "Box"("productId");
CREATE INDEX "Box_isActive_sortOrder_idx" ON "Box"("isActive", "sortOrder");
ALTER TABLE "Box" ADD CONSTRAINT "Box_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
