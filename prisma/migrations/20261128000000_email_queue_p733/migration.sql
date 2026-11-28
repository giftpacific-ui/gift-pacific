-- P7.3.3: e-mail queue foundation.
-- ADDITIVE ONLY: one enum, one new table, indexes. No existing table or row is altered.
--
-- ROLLBACK (manual; the table only holds queued/recent e-mail jobs):
--   DROP TABLE "EmailJob";
--   DROP TYPE "EmailJobStatus";

CREATE TYPE "EmailJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE "EmailJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT,
    "status" "EmailJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailJob_pkey" PRIMARY KEY ("id")
);

-- De-duplication: the same logical e-mail can exist only once.
CREATE UNIQUE INDEX "EmailJob_dedupeKey_key" ON "EmailJob"("dedupeKey");
CREATE INDEX "EmailJob_status_priority_nextAttemptAt_idx" ON "EmailJob"("status", "priority", "nextAttemptAt");
CREATE INDEX "EmailJob_status_sentAt_idx" ON "EmailJob"("status", "sentAt");
CREATE INDEX "EmailJob_createdAt_idx" ON "EmailJob"("createdAt");
