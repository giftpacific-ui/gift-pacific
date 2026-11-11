CREATE TYPE "ChannelKind" AS ENUM ('WEBSITE', 'MARKETPLACE', 'OTHER');
CREATE TYPE "FulfillmentMode" AS ENUM ('SELF_SHIP', 'MARKETPLACE_FULFILLED');
CREATE TYPE "CostKind" AS ENUM ('MARKETPLACE_COMMISSION', 'PAYMENT_FEE', 'COURIER_FEE', 'PACKAGING', 'OTHER');
CREATE TYPE "ConsentMode" AS ENUM ('OFF', 'OPT_IN');

-- Payment collected by the marketplace (never used by website checkout).
ALTER TYPE "PaymentMethod" ADD VALUE 'MARKETPLACE';

CREATE TABLE "SalesChannel" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "SalesChannel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesChannel_key_key" ON "SalesChannel"("key");

-- Configuration rows (not demo data): the website channel every existing order belongs to,
-- plus the two marketplaces named by the business. More can be added in the admin.
INSERT INTO "SalesChannel" ("id", "key", "name", "kind", "isActive") VALUES
  ('channel_website', 'website', 'Website', 'WEBSITE', true),
  ('channel_daraz', 'daraz', 'Daraz', 'MARKETPLACE', true),
  ('channel_cartup', 'cartup', 'Cartup', 'MARKETPLACE', true);

-- A constant DEFAULT is applied to existing rows without rewriting the table, so every
-- existing order becomes a website order atomically.
ALTER TABLE "Order"
  ADD COLUMN "channelId" TEXT NOT NULL DEFAULT 'channel_website',
  ADD COLUMN "externalOrderRef" TEXT,
  ADD COLUMN "externalPlacedAt" TIMESTAMP(3),
  ADD COLUMN "fulfillmentMode" "FulfillmentMode" NOT NULL DEFAULT 'SELF_SHIP',
  ADD COLUMN "createdById" TEXT;

-- Marketplaces do not always give an email address.
ALTER TABLE "Order" ALTER COLUMN "email" DROP NOT NULL;

CREATE INDEX "Order_channelId_createdAt_idx" ON "Order"("channelId", "createdAt");
-- NULLs are distinct in PostgreSQL, so website orders (no external ref) never collide.
CREATE UNIQUE INDEX "Order_channelId_externalOrderRef_key" ON "Order"("channelId", "externalOrderRef");
ALTER TABLE "Order" ADD CONSTRAINT "Order_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "SalesChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "OrderCostLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "CostKind" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderCostLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderCostLine_amount_check" CHECK ("amount" >= 0)
);
CREATE INDEX "OrderCostLine_orderId_idx" ON "OrderCostLine"("orderId");
ALTER TABLE "OrderCostLine" ADD CONSTRAINT "OrderCostLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "spentOn" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "channelId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Expense_amount_check" CHECK ("amount" >= 0)
);
CREATE INDEX "Expense_spentOn_idx" ON "Expense"("spentOn");

ALTER TABLE "StoreSettings"
  ADD COLUMN "tiktokPixelId" TEXT,
  ADD COLUMN "linkedinPartnerId" TEXT,
  ADD COLUMN "consentMode" "ConsentMode" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "seoTitleTemplate" TEXT,
  ADD COLUMN "seoDescription" TEXT,
  ADD COLUMN "ogImageUrl" TEXT;
