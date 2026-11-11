-- ===== Enums =====
CREATE TYPE "ProductKind" AS ENUM ('SINGLE', 'COMBO');
CREATE TYPE "ComboMode" AS ENUM ('FIXED', 'CUSTOMIZABLE');
CREATE TYPE "ComboPricing" AS ENUM ('FIXED_PRICE', 'COMPONENT_SUM');
CREATE TYPE "ComboStockPolicy" AS ENUM ('OWN_STOCK', 'COMPONENTS');
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'HIDDEN');
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'FACEBOOK');
CREATE TYPE "AttributeValueType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'MULTI_SELECT');
CREATE TYPE "TeamSection" AS ENUM ('MANAGEMENT', 'STAFF');
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');
CREATE TYPE "ApplicationStatus" AS ENUM ('NEW', 'REVIEWING', 'SHORTLISTED', 'INTERVIEW', 'REJECTED', 'HIRED');

-- ===== Product: explicit kind + combo configuration =====
ALTER TABLE "Product"
  ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN "comboMode" "ComboMode",
  ADD COLUMN "comboPricing" "ComboPricing",
  ADD COLUMN "comboStockPolicy" "ComboStockPolicy";

-- Existing bundles keep EXACTLY their current behaviour: fixed contents, fixed price,
-- their own stock (components are descriptive).
UPDATE "Product"
SET "kind" = 'COMBO', "comboMode" = 'FIXED', "comboPricing" = 'FIXED_PRICE', "comboStockPolicy" = 'OWN_STOCK'
WHERE "type" = 'BUNDLE';

-- kind = COMBO <=> type = BUNDLE <=> combo columns set; a customizable combo has no
-- finished-goods stock to count, so it must use component stock.
ALTER TABLE "Product" ADD CONSTRAINT "Product_combo_consistency_check" CHECK (
  (("kind" = 'COMBO') = ("type" = 'BUNDLE'))
  AND (("kind" = 'COMBO') = ("comboMode" IS NOT NULL))
  AND (("comboMode" IS NOT NULL) = ("comboPricing" IS NOT NULL))
  AND (("comboMode" IS NOT NULL) = ("comboStockPolicy" IS NOT NULL))
  AND ("comboMode" IS NULL OR "comboMode" <> 'CUSTOMIZABLE' OR "comboStockPolicy" = 'COMPONENTS')
);

CREATE INDEX "Product_kind_status_createdAt_idx" ON "Product"("kind", "status", "createdAt");

-- ===== Fixed combo components: optional pinned variant =====
ALTER TABLE "ProductBundleItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "ProductBundleItem" ADD CONSTRAINT "ProductBundleItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== Customizable combos =====
CREATE TABLE "ComboSlot" (
    "id" TEXT NOT NULL,
    "comboId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "minSelect" INTEGER NOT NULL DEFAULT 1,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "maxPerOption" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ComboSlot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ComboSlot_limits_check" CHECK ("minSelect" >= 0 AND "maxSelect" >= 1 AND "maxSelect" >= "minSelect" AND "maxPerOption" >= 1)
);
CREATE INDEX "ComboSlot_comboId_idx" ON "ComboSlot"("comboId");

CREATE TABLE "ComboSlotOption" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "priceDelta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ComboSlotOption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ComboSlotOption_priceDelta_check" CHECK ("priceDelta" >= 0)
);
CREATE UNIQUE INDEX "ComboSlotOption_slotId_productId_variantId_key" ON "ComboSlotOption"("slotId", "productId", "variantId");
CREATE INDEX "ComboSlotOption_productId_idx" ON "ComboSlotOption"("productId");

CREATE TABLE "CartItemSelection" (
    "id" TEXT NOT NULL,
    "cartItemId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "CartItemSelection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CartItemSelection_quantity_check" CHECK ("quantity" >= 1)
);
CREATE INDEX "CartItemSelection_cartItemId_idx" ON "CartItemSelection"("cartItemId");

CREATE TABLE "OrderItemComponent" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "slotLabel" TEXT,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "unitCost" DECIMAL(10,2),
    "stockDeducted" INTEGER NOT NULL DEFAULT 0,
    "stockRestoredAt" TIMESTAMP(3),
    CONSTRAINT "OrderItemComponent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderItemComponent_orderItemId_idx" ON "OrderItemComponent"("orderItemId");
CREATE INDEX "OrderItemComponent_productId_idx" ON "OrderItemComponent"("productId");

ALTER TABLE "OrderItem" ADD COLUMN "comboSnapshot" JSONB;

ALTER TABLE "ComboSlot" ADD CONSTRAINT "ComboSlot_comboId_fkey" FOREIGN KEY ("comboId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComboSlotOption" ADD CONSTRAINT "ComboSlotOption_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "ComboSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComboSlotOption" ADD CONSTRAINT "ComboSlotOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComboSlotOption" ADD CONSTRAINT "ComboSlotOption_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CartItemSelection" ADD CONSTRAINT "CartItemSelection_cartItemId_fkey" FOREIGN KEY ("cartItemId") REFERENCES "CartItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemComponent" ADD CONSTRAINT "OrderItemComponent_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemComponent" ADD CONSTRAINT "OrderItemComponent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemComponent" ADD CONSTRAINT "OrderItemComponent_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== Attributes =====
CREATE TABLE "AttributeGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "AttributeGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttributeGroup_slug_key" ON "AttributeGroup"("slug");

CREATE TABLE "Attribute" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "valueType" "AttributeValueType" NOT NULL,
    "unit" TEXT,
    "minNumber" DECIMAL(14,4),
    "maxNumber" DECIMAL(14,4),
    "maxLength" INTEGER,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isFilterable" BOOLEAN NOT NULL DEFAULT false,
    "showOnProduct" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Attribute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Attribute_slug_key" ON "Attribute"("slug");
CREATE INDEX "Attribute_groupId_sortOrder_idx" ON "Attribute"("groupId", "sortOrder");

CREATE TABLE "AttributeOption" (
    "id" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AttributeOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttributeOption_attributeId_value_key" ON "AttributeOption"("attributeId", "value");

CREATE TABLE "ProductAttributeValue" (
    "productId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "valueText" TEXT,
    "valueNumber" DECIMAL(14,4),
    "valueBoolean" BOOLEAN,
    CONSTRAINT "ProductAttributeValue_pkey" PRIMARY KEY ("productId","attributeId"),
    CONSTRAINT "ProductAttributeValue_one_value_check" CHECK (
      (("valueText" IS NOT NULL)::int + ("valueNumber" IS NOT NULL)::int + ("valueBoolean" IS NOT NULL)::int) = 1)
);
CREATE INDEX "ProductAttributeValue_attributeId_valueNumber_idx" ON "ProductAttributeValue"("attributeId", "valueNumber");
CREATE INDEX "ProductAttributeValue_attributeId_valueBoolean_idx" ON "ProductAttributeValue"("attributeId", "valueBoolean");

CREATE TABLE "ProductAttributeOption" (
    "productId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    CONSTRAINT "ProductAttributeOption_pkey" PRIMARY KEY ("productId","attributeId","optionId")
);
CREATE INDEX "ProductAttributeOption_attributeId_optionId_idx" ON "ProductAttributeOption"("attributeId", "optionId");

ALTER TABLE "Attribute" ADD CONSTRAINT "Attribute_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AttributeGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttributeOption" ADD CONSTRAINT "AttributeOption_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAttributeValue" ADD CONSTRAINT "ProductAttributeValue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAttributeValue" ADD CONSTRAINT "ProductAttributeValue_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAttributeOption" ADD CONSTRAINT "ProductAttributeOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAttributeOption" ADD CONSTRAINT "ProductAttributeOption_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAttributeOption" ADD CONSTRAINT "ProductAttributeOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "AttributeOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== Team, About, Career =====
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "section" "TeamSection" NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "bio" TEXT,
    "imageUrl" TEXT,
    "imageCloudinaryPublicId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TeamMember_isPublished_section_sortOrder_idx" ON "TeamMember"("isPublished", "section", "sortOrder");

CREATE TABLE "JobPost" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT,
    "location" TEXT,
    "employmentType" TEXT,
    "description" TEXT NOT NULL,
    "requirements" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "closesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobPost_slug_key" ON "JobPost"("slug");
CREATE INDEX "JobPost_status_closesAt_idx" ON "JobPost"("status", "closesAt");

CREATE TABLE "JobQuestion" (
    "id" TEXT NOT NULL,
    "jobPostId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "options" TEXT[],
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "JobQuestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobQuestion_jobPostId_idx" ON "JobQuestion"("jobPostId");

CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "jobPostId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "coverNote" TEXT,
    "portfolioUrl" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'NEW',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobApplication_jobPostId_status_createdAt_idx" ON "JobApplication"("jobPostId", "status", "createdAt");

CREATE TABLE "JobApplicationAnswer" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "questionLabel" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "JobApplicationAnswer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobApplicationAnswer_applicationId_idx" ON "JobApplicationAnswer"("applicationId");

ALTER TABLE "JobQuestion" ADD CONSTRAINT "JobQuestion_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobApplicationAnswer" ADD CONSTRAINT "JobApplicationAnswer_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "JobApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== Social login: nullable password + provider accounts =====
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TABLE "OAuthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "emailAtLink" TEXT,
    "emailVerifiedByProvider" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");
CREATE UNIQUE INDEX "OAuthAccount_userId_provider_key" ON "OAuthAccount"("userId", "provider");
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== Review lifecycle =====
ALTER TABLE "Review" ADD COLUMN "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING', ADD COLUMN "orderItemId" TEXT;

UPDATE "Review" SET "status" = CASE
  WHEN "isApproved" THEN 'APPROVED'::"ReviewStatus"
  WHEN "rejectedAt" IS NOT NULL THEN 'REJECTED'::"ReviewStatus"
  ELSE 'PENDING'::"ReviewStatus" END;

-- Best-effort link to the delivered order item that earned each existing review (the user's
-- most recent DELIVERED order containing the product). Unmatched legacy reviews stay NULL and
-- are grandfathered (still public when approved).
UPDATE "Review" r SET "orderItemId" = m."oid"
FROM (
  SELECT DISTINCT ON (r2."id") r2."id" AS "rid", oi."id" AS "oid"
  FROM "Review" r2
  JOIN "Order" o ON o."userId" = r2."userId" AND o."status" = 'DELIVERED'
  JOIN "OrderItem" oi ON oi."orderId" = o."id" AND oi."productId" = r2."productId"
  ORDER BY r2."id", o."createdAt" DESC
) m
WHERE r."id" = m."rid";

CREATE UNIQUE INDEX "Review_orderItemId_key" ON "Review"("orderItemId");
CREATE INDEX "Review_status_idx" ON "Review"("status");
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReviewModerationEvent" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewModerationEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReviewModerationEvent_reviewId_createdAt_idx" ON "ReviewModerationEvent"("reviewId", "createdAt");
ALTER TABLE "ReviewModerationEvent" ADD CONSTRAINT "ReviewModerationEvent_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- History for reviews that already exist, so moderation history is never empty for them.
INSERT INTO "ReviewModerationEvent" ("id", "reviewId", "action", "actorId", "note")
SELECT 'rme_' || "id", "id",
  CASE "status" WHEN 'APPROVED' THEN 'MIGRATED_APPROVED' WHEN 'REJECTED' THEN 'MIGRATED_REJECTED' ELSE 'MIGRATED_PENDING' END,
  NULL, 'Existing review at migration time'
FROM "Review";
