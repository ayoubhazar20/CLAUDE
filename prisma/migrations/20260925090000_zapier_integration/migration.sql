-- CreateEnum
CREATE TYPE "SyncEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('APPLIED', 'PENDING_REVIEW', 'DISMISSED');

-- DropForeignKey
ALTER TABLE "hubspot_connections" DROP CONSTRAINT "hubspot_connections_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "hubspot_pipeline_mappings" DROP CONSTRAINT "hubspot_pipeline_mappings_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "hubspot_property_mappings" DROP CONSTRAINT "hubspot_property_mappings_organizationId_fkey";

-- AlterTable
ALTER TABLE "documents" DROP COLUMN "hubspotConnectionId",
DROP COLUMN "hubspotPortalId",
ADD COLUMN     "dealDataRequestedAt" TIMESTAMP(3),
ADD COLUMN     "dealDataStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
ADD COLUMN     "hubspotLinkedAt" TIMESTAMP(3),
ADD COLUMN     "hubspotObjectRecordId" TEXT,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "plans" DROP COLUMN "maxHubSpotConnections";

-- DropTable
DROP TABLE "hubspot_connections";

-- DropTable
DROP TABLE "hubspot_pipeline_mappings";

-- DropTable
DROP TABLE "hubspot_property_mappings";

-- DropTable
DROP TABLE "hubspot_webhook_events";

-- DropTable
DROP TABLE "oauth_states";

-- DropEnum
DROP TYPE "AutomationEvent";

-- DropEnum
DROP TYPE "HubSpotConnectionStatus";

-- DropEnum
DROP TYPE "HubSpotObjectType";

-- DropEnum
DROP TYPE "MappingDirection";

-- DropEnum
DROP TYPE "WebhookEventStatus";

-- CreateTable
CREATE TABLE "zapier_integrations" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hubspotObjectTypeId" TEXT,
    "webhookUrl" TEXT,
    "secretHash" TEXT,
    "secretEnc" TEXT,
    "secretPrefix" TEXT,
    "secretRotatedAt" TIMESTAMP(3),
    "dealPropertyNames" JSONB NOT NULL DEFAULT '{}',
    "statusMapping" JSONB NOT NULL DEFAULT '{}',
    "propertyVariableMap" JSONB NOT NULL DEFAULT '{}',
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zapier_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "documentId" UUID,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "SyncEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "direction" "SyncDirection" NOT NULL,
    "eventType" TEXT NOT NULL,
    "documentId" UUID,
    "syncEventId" UUID,
    "success" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "externalId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_snapshots" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "dealId" TEXT,
    "kind" TEXT NOT NULL,
    "status" "SnapshotStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,

    CONSTRAINT "deal_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zapier_integrations_organizationId_key" ON "zapier_integrations"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "zapier_integrations_secretHash_key" ON "zapier_integrations"("secretHash");

-- CreateIndex
CREATE INDEX "sync_events_organizationId_createdAt_idx" ON "sync_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "sync_events_status_idx" ON "sync_events"("status");

-- CreateIndex
CREATE INDEX "sync_logs_organizationId_createdAt_idx" ON "sync_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_logs_organizationId_direction_externalId_key" ON "sync_logs"("organizationId", "direction", "externalId");

-- CreateIndex
CREATE INDEX "deal_snapshots_documentId_receivedAt_idx" ON "deal_snapshots"("documentId", "receivedAt");

-- CreateIndex
CREATE INDEX "documents_organizationId_hubspotObjectRecordId_idx" ON "documents"("organizationId", "hubspotObjectRecordId");

-- AddForeignKey
ALTER TABLE "zapier_integrations" ADD CONSTRAINT "zapier_integrations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_snapshots" ADD CONSTRAINT "deal_snapshots_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

