-- P3 tracking: server-side event log (idempotent Purchase lifecycle) + per-order attribution snapshot.
-- ADDITIVE ONLY: two enums, two new tables, indexes and foreign keys. No existing table or column is altered or dropped.
-- Sorts after 20261121000000_seo_keywords_not_null.
--
-- Rollback (manual, only if nothing depends on it; this deletes the tracking audit trail):
--   DROP TABLE "OrderAttribution"; DROP TABLE "TrackingEventLog";
--   DROP TYPE "TrackingConsentState"; DROP TYPE "TrackingEventStatus";

-- CreateEnum
CREATE TYPE "TrackingEventStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TrackingConsentState" AS ENUM ('GRANTED', 'DENIED', 'UNKNOWN', 'NOT_REQUIRED');

-- CreateTable
CREATE TABLE "TrackingEventLog" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL DEFAULT 'META_CAPI',
    "eventName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "TrackingEventStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "fbtraceId" TEXT,
    "apiVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAttribution" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "firstTouch" JSONB,
    "lastTouch" JSONB,
    "fbc" TEXT,
    "fbp" TEXT,
    "clientIp" TEXT,
    "clientUserAgent" TEXT,
    "contactScrubbedAt" TIMESTAMP(3),
    "consentState" "TrackingConsentState" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEventLog_destination_eventName_orderId_key" ON "TrackingEventLog"("destination", "eventName", "orderId");

-- CreateIndex
CREATE INDEX "TrackingEventLog_status_nextAttemptAt_idx" ON "TrackingEventLog"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TrackingEventLog_createdAt_idx" ON "TrackingEventLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAttribution_orderId_key" ON "OrderAttribution"("orderId");

-- CreateIndex
CREATE INDEX "OrderAttribution_userId_idx" ON "OrderAttribution"("userId");

-- CreateIndex
CREATE INDEX "OrderAttribution_createdAt_idx" ON "OrderAttribution"("createdAt");

-- AddForeignKey
ALTER TABLE "TrackingEventLog" ADD CONSTRAINT "TrackingEventLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAttribution" ADD CONSTRAINT "OrderAttribution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
