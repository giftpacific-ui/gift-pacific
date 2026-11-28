-- Prompt 07: email marketing database architecture (schema only).
-- ADDITIVE ONLY: new enums, new tables, indexes, CHECK constraints and foreign keys. NO existing table is altered, dropped, rewritten or backfilled.
-- "EmailJob" in particular is untouched: the new tables reference it (ON DELETE SET NULL), it does not reference them, so transactional e-mail and
-- the queue behave exactly as before. No customer is imported as a contact and nobody is given marketing consent by this migration.
--
-- Not expressible in schema.prisma (so `prisma migrate diff` lists them as drift; keep them, same as IncompleteCheckout's partial index):
--   * the partial unique index "MarketingConsent_contactId_active_key" (one open consent per contact)
--   * every CHECK constraint
--
-- ROLLBACK (manual; run in this order; the tables only hold marketing data created after this migration):
--   DROP TABLE "RecoveryEmail";
--   DROP TABLE "EmailCampaignRecipient";
--   DROP TABLE "EmailCampaign";
--   DROP TABLE "EmailTemplate";
--   DROP TABLE "EmailSuppression";
--   DROP TABLE "MarketingConsent";
--   DROP TABLE "EmailContact";
--   DROP TYPE "RecoveryEmailKind";
--   DROP TYPE "EmailDeliveryStatus";
--   DROP TYPE "EmailCampaignStatus";
--   DROP TYPE "EmailTemplateCategory";
--   DROP TYPE "EmailSuppressionReason";
--   DROP TYPE "MarketingUnsubscribeSource";
--   DROP TYPE "MarketingConsentSource";
--   DROP TYPE "EmailContactSource";

-- CreateEnum
CREATE TYPE "EmailContactSource" AS ENUM ('MANUAL', 'CSV_IMPORT', 'CUSTOMER');
CREATE TYPE "MarketingConsentSource" AS ENUM ('ADMIN_RECORDED', 'CSV_IMPORT', 'CUSTOMER_ACCOUNT', 'CHECKOUT_MARKETING', 'SIGNUP_FORM');
CREATE TYPE "MarketingUnsubscribeSource" AS ENUM ('LINK', 'ADMIN', 'CUSTOMER_ACCOUNT', 'BOUNCE', 'COMPLAINT');
CREATE TYPE "EmailSuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'ADMIN');
CREATE TYPE "EmailTemplateCategory" AS ENUM ('MARKETING', 'NEWSLETTER', 'RECOVERY', 'OTHER');
CREATE TYPE "EmailCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "RecoveryEmailKind" AS ENUM ('ABANDONED_CART', 'INCOMPLETE_CHECKOUT');

-- CreateTable
CREATE TABLE "EmailContact" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "source" "EmailContactSource" NOT NULL,
    "userId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "unsubscribeTokenHash" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailContact_pkey" PRIMARY KEY ("id"),
    -- stored normalised (trimmed, lower-case): the unique index then makes "A@x.com" and "a@x.com" the same contact
    CONSTRAINT "EmailContact_email_normalized_check" CHECK ("email" = lower(btrim("email")) AND char_length("email") BETWEEN 3 AND 254),
    -- only a SHA-256 hex digest can be stored here, never a raw token
    CONSTRAINT "EmailContact_unsubscribeTokenHash_format_check" CHECK ("unsubscribeTokenHash" IS NULL OR "unsubscribeTokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EmailContact_name_length_check" CHECK ("name" IS NULL OR char_length("name") <= 200)
);

CREATE TABLE "MarketingConsent" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "source" "MarketingConsentSource" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidence" TEXT,
    "recordedById" TEXT,
    "unsubscribedAt" TIMESTAMP(3),
    "unsubscribeSource" "MarketingUnsubscribeSource",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingConsent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MarketingConsent_unsubscribe_pair_check" CHECK (("unsubscribedAt" IS NULL) = ("unsubscribeSource" IS NULL)),
    CONSTRAINT "MarketingConsent_unsubscribe_after_grant_check" CHECK ("unsubscribedAt" IS NULL OR "unsubscribedAt" >= "grantedAt"),
    CONSTRAINT "MarketingConsent_evidence_length_check" CHECK ("evidence" IS NULL OR char_length("evidence") <= 500)
);

CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "contactId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailSuppression_email_normalized_check" CHECK ("email" = lower(btrim("email")) AND char_length("email") BETWEEN 3 AND 254),
    CONSTRAINT "EmailSuppression_note_length_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);

CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "EmailTemplateCategory" NOT NULL DEFAULT 'MARKETING',
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id"),
    -- the same bounds the e-mail queue enforces on an EmailJob (lib/email/queue-policy.ts EMAIL_LIMITS), so a template can always be queued
    CONSTRAINT "EmailTemplate_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "EmailTemplate_subject_length_check" CHECK (char_length("subject") BETWEEN 1 AND 200),
    CONSTRAINT "EmailTemplate_textBody_length_check" CHECK (char_length("textBody") BETWEEN 1 AND 100000),
    CONSTRAINT "EmailTemplate_htmlBody_length_check" CHECK ("htmlBody" IS NULL OR char_length("htmlBody") <= 200000)
);

CREATE TABLE "EmailCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "EmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "templateId" TEXT,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailCampaign_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 160),
    -- a draft may still be empty; once the campaign leaves DRAFT it must be sendable
    CONSTRAINT "EmailCampaign_subject_length_check" CHECK (char_length("subject") <= 200 AND ("status" = 'DRAFT' OR char_length("subject") >= 1)),
    CONSTRAINT "EmailCampaign_textBody_length_check" CHECK (char_length("textBody") <= 100000 AND ("status" = 'DRAFT' OR char_length("textBody") >= 1)),
    CONSTRAINT "EmailCampaign_htmlBody_length_check" CHECK ("htmlBody" IS NULL OR char_length("htmlBody") <= 200000),
    CONSTRAINT "EmailCampaign_counts_check" CHECK ("recipientCount" >= 0 AND "sentCount" >= 0 AND "failedCount" >= 0 AND "skippedCount" >= 0 AND "sentCount" + "failedCount" + "skippedCount" <= "recipientCount"),
    CONSTRAINT "EmailCampaign_scheduled_needs_time_check" CHECK ("status" <> 'SCHEDULED' OR "scheduledAt" IS NOT NULL),
    CONSTRAINT "EmailCampaign_completed_needs_time_check" CHECK ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL),
    CONSTRAINT "EmailCampaign_failure_reason_length_check" CHECK ("failureReason" IS NULL OR char_length("failureReason") <= 300)
);

CREATE TABLE "EmailCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "emailJobId" TEXT,
    "consentId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaignRecipient_pkey" PRIMARY KEY ("id"),
    -- a skip reason exists exactly when the row was skipped
    CONSTRAINT "EmailCampaignRecipient_skip_reason_check" CHECK (("status" = 'SKIPPED') = ("skipReason" IS NOT NULL))
);

CREATE TABLE "RecoveryEmail" (
    "id" TEXT NOT NULL,
    "kind" "RecoveryEmailKind" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 1,
    "contactId" TEXT NOT NULL,
    "incompleteCheckoutId" TEXT,
    "cartId" TEXT,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "emailJobId" TEXT,
    "consentId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryEmail_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecoveryEmail_step_range_check" CHECK ("step" BETWEEN 1 AND 10),
    -- the event key says which kind of recovery event this is, so the two kinds can never be mixed up or collide
    CONSTRAINT "RecoveryEmail_eventKey_kind_check" CHECK (
        ("kind" = 'INCOMPLETE_CHECKOUT' AND "eventKey" LIKE 'ic:%') OR ("kind" = 'ABANDONED_CART' AND "eventKey" LIKE 'ac:%')
    ),
    CONSTRAINT "RecoveryEmail_eventKey_length_check" CHECK (char_length("eventKey") BETWEEN 4 AND 200),
    CONSTRAINT "RecoveryEmail_skip_reason_check" CHECK (("status" = 'SKIPPED') = ("skipReason" IS NOT NULL))
);

-- Unique constraints / de-duplication
CREATE UNIQUE INDEX "EmailContact_email_key" ON "EmailContact"("email");
CREATE UNIQUE INDEX "EmailContact_unsubscribeTokenHash_key" ON "EmailContact"("unsubscribeTokenHash");
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");
CREATE UNIQUE INDEX "EmailTemplate_name_key" ON "EmailTemplate"("name");
CREATE UNIQUE INDEX "EmailCampaignRecipient_emailJobId_key" ON "EmailCampaignRecipient"("emailJobId");
CREATE UNIQUE INDEX "EmailCampaignRecipient_campaignId_contactId_key" ON "EmailCampaignRecipient"("campaignId", "contactId");
CREATE UNIQUE INDEX "RecoveryEmail_emailJobId_key" ON "RecoveryEmail"("emailJobId");
CREATE UNIQUE INDEX "RecoveryEmail_eventKey_step_key" ON "RecoveryEmail"("eventKey", "step");

-- At most ONE open (not unsubscribed) consent per contact. Re-opting in after an unsubscribe is a new row. (Partial index: not expressible in schema.prisma.)
CREATE UNIQUE INDEX "MarketingConsent_contactId_active_key" ON "MarketingConsent"("contactId") WHERE "unsubscribedAt" IS NULL;

-- Lookup indexes
CREATE INDEX "EmailContact_userId_idx" ON "EmailContact"("userId");
CREATE INDEX "EmailContact_isActive_createdAt_idx" ON "EmailContact"("isActive", "createdAt");
CREATE INDEX "MarketingConsent_contactId_grantedAt_idx" ON "MarketingConsent"("contactId", "grantedAt");
CREATE INDEX "EmailSuppression_reason_idx" ON "EmailSuppression"("reason");
CREATE INDEX "EmailSuppression_contactId_idx" ON "EmailSuppression"("contactId");
CREATE INDEX "EmailTemplate_category_isActive_idx" ON "EmailTemplate"("category", "isActive");
CREATE INDEX "EmailCampaign_status_scheduledAt_idx" ON "EmailCampaign"("status", "scheduledAt");
CREATE INDEX "EmailCampaign_createdAt_idx" ON "EmailCampaign"("createdAt");
CREATE INDEX "EmailCampaign_templateId_idx" ON "EmailCampaign"("templateId");
CREATE INDEX "EmailCampaignRecipient_campaignId_status_idx" ON "EmailCampaignRecipient"("campaignId", "status");
CREATE INDEX "EmailCampaignRecipient_contactId_idx" ON "EmailCampaignRecipient"("contactId");
CREATE INDEX "EmailCampaignRecipient_consentId_idx" ON "EmailCampaignRecipient"("consentId");
CREATE INDEX "RecoveryEmail_contactId_idx" ON "RecoveryEmail"("contactId");
CREATE INDEX "RecoveryEmail_status_createdAt_idx" ON "RecoveryEmail"("status", "createdAt");
CREATE INDEX "RecoveryEmail_incompleteCheckoutId_idx" ON "RecoveryEmail"("incompleteCheckoutId");
CREATE INDEX "RecoveryEmail_cartId_idx" ON "RecoveryEmail"("cartId");
CREATE INDEX "RecoveryEmail_consentId_idx" ON "RecoveryEmail"("consentId");

-- Foreign keys. History is protected: contacts, consents, campaigns are RESTRICTed. Optional links to rows that are purged on a schedule
-- (EmailJob, Cart, IncompleteCheckout) and to things that may be removed (User, EmailTemplate) are cleared with SET NULL.
ALTER TABLE "EmailContact" ADD CONSTRAINT "EmailContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingConsent" ADD CONSTRAINT "MarketingConsent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailCampaignRecipient" ADD CONSTRAINT "EmailCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailCampaignRecipient" ADD CONSTRAINT "EmailCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailCampaignRecipient" ADD CONSTRAINT "EmailCampaignRecipient_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailCampaignRecipient" ADD CONSTRAINT "EmailCampaignRecipient_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "MarketingConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryEmail" ADD CONSTRAINT "RecoveryEmail_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryEmail" ADD CONSTRAINT "RecoveryEmail_incompleteCheckoutId_fkey" FOREIGN KEY ("incompleteCheckoutId") REFERENCES "IncompleteCheckout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecoveryEmail" ADD CONSTRAINT "RecoveryEmail_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecoveryEmail" ADD CONSTRAINT "RecoveryEmail_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecoveryEmail" ADD CONSTRAINT "RecoveryEmail_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "MarketingConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
