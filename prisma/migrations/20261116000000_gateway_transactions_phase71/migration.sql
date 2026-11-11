-- Phase 7.1: online wallet gateway transactions. ADDITIVE ONLY: three enums, two tables, indexes. No existing data is touched.

CREATE TYPE "GatewayProvider" AS ENUM ('BKASH', 'NAGAD');
CREATE TYPE "GatewayTxnStatus" AS ENUM ('INITIATED', 'PENDING_APPROVAL', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'NEEDS_REVIEW');
CREATE TYPE "GatewayRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "GatewayTransaction" (
    "id" TEXT NOT NULL,
    "provider" "GatewayProvider" NOT NULL,
    "orderId" TEXT NOT NULL,
    "purpose" "PaymentKind" NOT NULL DEFAULT 'ADVANCE',
    "merchantInvoiceNumber" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "providerTrxId" TEXT,
    "status" "GatewayTxnStatus" NOT NULL DEFAULT 'INITIATED',
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "environment" TEXT NOT NULL,
    "redirectUrl" TEXT,
    "providerStatus" TEXT,
    "providerStatusCode" TEXT,
    "failureReason" TEXT,
    "rawInitiate" JSONB,
    "rawVerify" JSONB,
    "paymentId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GatewayRefund" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "GatewayRefundStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "providerRefundTrxId" TEXT,
    "providerStatus" TEXT,
    "rawResponse" JSONB,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GatewayTransaction_merchantInvoiceNumber_key" ON "GatewayTransaction"("merchantInvoiceNumber");
CREATE UNIQUE INDEX "GatewayTransaction_providerPaymentId_key" ON "GatewayTransaction"("providerPaymentId");
CREATE UNIQUE INDEX "GatewayTransaction_paymentId_key" ON "GatewayTransaction"("paymentId");
CREATE INDEX "GatewayTransaction_orderId_idx" ON "GatewayTransaction"("orderId");
CREATE INDEX "GatewayTransaction_provider_status_idx" ON "GatewayTransaction"("provider", "status");
CREATE UNIQUE INDEX "GatewayRefund_idempotencyKey_key" ON "GatewayRefund"("idempotencyKey");
CREATE INDEX "GatewayRefund_transactionId_idx" ON "GatewayRefund"("transactionId");

-- At most ONE open online attempt per order and purpose (stops duplicate payment initiation, even under concurrent requests).
CREATE UNIQUE INDEX "GatewayTransaction_one_open_per_order" ON "GatewayTransaction"("orderId", "purpose") WHERE "status" IN ('INITIATED', 'PENDING_APPROVAL', 'VERIFYING');

ALTER TABLE "GatewayTransaction" ADD CONSTRAINT "GatewayTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GatewayTransaction" ADD CONSTRAINT "GatewayTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GatewayRefund" ADD CONSTRAINT "GatewayRefund_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "GatewayTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
