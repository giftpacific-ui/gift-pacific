-- Boxes get box-specific price/stock through a managed (hidden) product. Existing products are unaffected.
ALTER TABLE "Product" ADD COLUMN "isBoxProduct" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Product_isBoxProduct_idx" ON "Product"("isBoxProduct");
