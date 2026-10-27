-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('SALES_FLOOR', 'BACK_ROOM', 'RECEIVING', 'DISPATCH', 'FITTING_ROOM', 'OTHER');

-- CreateEnum
CREATE TYPE "ZoneRelation" AS ENUM ('ADJACENT', 'DOORWAY', 'SHARED_WALL', 'SEPARATED');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('RECEIVED', 'REJECTED', 'FILE_DELETED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PARSING', 'CLASSIFYING', 'EXPORTING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "Classification" AS ENUM ('ACCEPTED', 'NEEDS_REVIEW', 'REJECTED_FROM_ZONE');

-- CreateEnum
CREATE TYPE "DatasetPurpose" AS ENUM ('CALIBRATION', 'GROUND_TRUTH');

-- CreateEnum
CREATE TYPE "LabelCategory" AS ENUM ('KNOWN_LOCATION', 'BOUNDARY', 'CROSS_READ_EXAMPLE', 'AMBIGUOUS');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeTenantId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ZoneType" NOT NULL,
    "aliases" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneRelationship" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "fromZoneId" TEXT NOT NULL,
    "toZoneId" TEXT NOT NULL,
    "relation" "ZoneRelation" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZoneRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "encoding" TEXT NOT NULL,
    "hasBom" BOOLEAN NOT NULL,
    "delimiter" TEXT NOT NULL,
    "lineEnding" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'RECEIVED',
    "zoneId" TEXT,
    "sessionLabel" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileDeletedAt" TIMESTAMP(3),

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColumnMappingProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "exportFormat" TEXT,
    "mapping" JSONB NOT NULL,
    "zoneValueMap" JSONB NOT NULL DEFAULT '{}',
    "dateFormat" TEXT NOT NULL DEFAULT 'AUTO',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColumnMappingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "tunedFromJobIds" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT,
    "inputHash" TEXT NOT NULL,
    "processingProfileId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT,
    "inputRowCount" INTEGER NOT NULL DEFAULT 0,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "uniqueEpcCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobUpload" (
    "jobId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,

    CONSTRAINT "JobUpload_pkey" PRIMARY KEY ("jobId","uploadId")
);

-- CreateTable
CREATE TABLE "ScanSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "zoneId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "observationCount" INTEGER NOT NULL,
    "uniqueEpcCount" INTEGER NOT NULL,

    CONSTRAINT "ScanSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawObservation" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "epcRaw" TEXT NOT NULL,
    "epc" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3),
    "rssi" DOUBLE PRECISION,
    "readCount" INTEGER,
    "phase" DOUBLE PRECISION,
    "readerId" TEXT,
    "antennaId" TEXT,
    "isAnchor" BOOLEAN NOT NULL DEFAULT false,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RawObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RowError" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "field" TEXT,

    CONSTRAINT "RowError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpcZoneSummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "epc" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "rawReadCount" INTEGER NOT NULL,
    "readCountComplete" BOOLEAN NOT NULL,
    "windowCount" INTEGER,
    "sessionCount" INTEGER NOT NULL,
    "firstSeen" TIMESTAMP(3),
    "lastSeen" TIMESTAMP(3),
    "medianRssi" DOUBLE PRECISION,
    "p25Rssi" DOUBLE PRECISION,
    "p75Rssi" DOUBLE PRECISION,
    "rssiCount" INTEGER NOT NULL,
    "readerIds" TEXT[],
    "antennaIds" TEXT[],
    "sessionKeys" TEXT[],
    "phaseAvailable" BOOLEAN NOT NULL,
    "dataQualityStatus" TEXT NOT NULL,

    CONSTRAINT "EpcZoneSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "epc" TEXT NOT NULL,
    "epcRaw" TEXT NOT NULL,
    "observedZoneIds" TEXT[],
    "classification" "Classification" NOT NULL,
    "assignedZoneId" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "confidenceType" TEXT NOT NULL,
    "confidenceBand" TEXT,
    "reasonCode" TEXT NOT NULL,
    "reasonDescription" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "evidenceAvailable" TEXT[],
    "rulesFired" TEXT[],
    "requiresManualReview" BOOLEAN NOT NULL,
    "zoneDispositions" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "ClassificationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOutput" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingMetrics" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnchorTag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "epc" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "AnchorTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationDataset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "DatasetPurpose" NOT NULL,
    "jobId" TEXT,
    "notes" TEXT,
    "labelCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroundTruthLabel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "epc" TEXT NOT NULL,
    "actualZoneId" TEXT NOT NULL,
    "category" "LabelCategory" NOT NULL DEFAULT 'KNOWN_LOCATION',
    "notes" TEXT,

    CONSTRAINT "GroundTruthLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "inSample" BOOLEAN NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQueue" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_userId_key" ON "Membership"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Store_tenantId_idx" ON "Store"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Store_tenantId_code_key" ON "Store"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Store_id_tenantId_key" ON "Store"("id", "tenantId");

-- CreateIndex
CREATE INDEX "Zone_tenantId_storeId_idx" ON "Zone"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_storeId_code_key" ON "Zone"("storeId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_id_tenantId_key" ON "Zone"("id", "tenantId");

-- CreateIndex
CREATE INDEX "ZoneRelationship_tenantId_storeId_idx" ON "ZoneRelationship"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneRelationship_storeId_fromZoneId_toZoneId_key" ON "ZoneRelationship"("storeId", "fromZoneId", "toZoneId");

-- CreateIndex
CREATE INDEX "Upload_tenantId_storeId_createdAt_idx" ON "Upload"("tenantId", "storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Upload_tenantId_storeId_sha256_idx" ON "Upload"("tenantId", "storeId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_id_tenantId_key" ON "Upload"("id", "tenantId");

-- CreateIndex
CREATE INDEX "ColumnMappingProfile_tenantId_storeId_idx" ON "ColumnMappingProfile"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ColumnMappingProfile_tenantId_name_key" ON "ColumnMappingProfile"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ProcessingProfile_tenantId_storeId_idx" ON "ProcessingProfile"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingProfile_tenantId_name_version_key" ON "ProcessingProfile"("tenantId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingProfile_id_tenantId_key" ON "ProcessingProfile"("id", "tenantId");

-- CreateIndex
CREATE INDEX "ProcessingJob_tenantId_storeId_createdAt_idx" ON "ProcessingJob"("tenantId", "storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_tenantId_status_idx" ON "ProcessingJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ProcessingJob_tenantId_inputHash_idx" ON "ProcessingJob"("tenantId", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_id_tenantId_key" ON "ProcessingJob"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_tenantId_idempotencyKey_key" ON "ProcessingJob"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JobUpload_tenantId_idx" ON "JobUpload"("tenantId");

-- CreateIndex
CREATE INDEX "ScanSession_tenantId_jobId_idx" ON "ScanSession"("tenantId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanSession_jobId_uploadId_externalId_key" ON "ScanSession"("jobId", "uploadId", "externalId");

-- CreateIndex
CREATE INDEX "RawObservation_tenantId_jobId_epc_idx" ON "RawObservation"("tenantId", "jobId", "epc");

-- CreateIndex
CREATE INDEX "RowError_tenantId_jobId_idx" ON "RowError"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "EpcZoneSummary_tenantId_jobId_zoneId_idx" ON "EpcZoneSummary"("tenantId", "jobId", "zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "EpcZoneSummary_jobId_epc_zoneId_key" ON "EpcZoneSummary"("jobId", "epc", "zoneId");

-- CreateIndex
CREATE INDEX "ClassificationResult_tenantId_jobId_classification_idx" ON "ClassificationResult"("tenantId", "jobId", "classification");

-- CreateIndex
CREATE INDEX "ClassificationResult_tenantId_jobId_assignedZoneId_idx" ON "ClassificationResult"("tenantId", "jobId", "assignedZoneId");

-- CreateIndex
CREATE INDEX "ClassificationResult_tenantId_epc_idx" ON "ClassificationResult"("tenantId", "epc");

-- CreateIndex
CREATE UNIQUE INDEX "ClassificationResult_jobId_epc_key" ON "ClassificationResult"("jobId", "epc");

-- CreateIndex
CREATE INDEX "JobOutput_tenantId_jobId_idx" ON "JobOutput"("tenantId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobOutput_jobId_kind_key" ON "JobOutput"("jobId", "kind");

-- CreateIndex
CREATE INDEX "ProcessingMetrics_tenantId_idx" ON "ProcessingMetrics"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingMetrics_jobId_key" ON "ProcessingMetrics"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingMetrics_jobId_tenantId_key" ON "ProcessingMetrics"("jobId", "tenantId");

-- CreateIndex
CREATE INDEX "AnchorTag_tenantId_storeId_idx" ON "AnchorTag"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "AnchorTag_storeId_epc_key" ON "AnchorTag"("storeId", "epc");

-- CreateIndex
CREATE INDEX "CalibrationDataset_tenantId_storeId_idx" ON "CalibrationDataset"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationDataset_id_tenantId_key" ON "CalibrationDataset"("id", "tenantId");

-- CreateIndex
CREATE INDEX "GroundTruthLabel_tenantId_idx" ON "GroundTruthLabel"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GroundTruthLabel_datasetId_epc_key" ON "GroundTruthLabel"("datasetId", "epc");

-- CreateIndex
CREATE INDEX "Evaluation_tenantId_jobId_idx" ON "Evaluation"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_action_idx" ON "AuditEvent"("tenantId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "JobQueue_jobId_key" ON "JobQueue"("jobId");

-- CreateIndex
CREATE INDEX "JobQueue_status_runAfter_idx" ON "JobQueue"("status", "runAfter");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_storeId_tenantId_fkey" FOREIGN KEY ("storeId", "tenantId") REFERENCES "Store"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRelationship" ADD CONSTRAINT "ZoneRelationship_storeId_tenantId_fkey" FOREIGN KEY ("storeId", "tenantId") REFERENCES "Store"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRelationship" ADD CONSTRAINT "ZoneRelationship_fromZoneId_tenantId_fkey" FOREIGN KEY ("fromZoneId", "tenantId") REFERENCES "Zone"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRelationship" ADD CONSTRAINT "ZoneRelationship_toZoneId_tenantId_fkey" FOREIGN KEY ("toZoneId", "tenantId") REFERENCES "Zone"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_storeId_tenantId_fkey" FOREIGN KEY ("storeId", "tenantId") REFERENCES "Store"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_storeId_tenantId_fkey" FOREIGN KEY ("storeId", "tenantId") REFERENCES "Store"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_processingProfileId_tenantId_fkey" FOREIGN KEY ("processingProfileId", "tenantId") REFERENCES "ProcessingProfile"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobUpload" ADD CONSTRAINT "JobUpload_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobUpload" ADD CONSTRAINT "JobUpload_uploadId_tenantId_fkey" FOREIGN KEY ("uploadId", "tenantId") REFERENCES "Upload"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanSession" ADD CONSTRAINT "ScanSession_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawObservation" ADD CONSTRAINT "RawObservation_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RowError" ADD CONSTRAINT "RowError_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpcZoneSummary" ADD CONSTRAINT "EpcZoneSummary_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationResult" ADD CONSTRAINT "ClassificationResult_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOutput" ADD CONSTRAINT "JobOutput_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingMetrics" ADD CONSTRAINT "ProcessingMetrics_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnchorTag" ADD CONSTRAINT "AnchorTag_storeId_tenantId_fkey" FOREIGN KEY ("storeId", "tenantId") REFERENCES "Store"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnchorTag" ADD CONSTRAINT "AnchorTag_zoneId_tenantId_fkey" FOREIGN KEY ("zoneId", "tenantId") REFERENCES "Zone"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationDataset" ADD CONSTRAINT "CalibrationDataset_storeId_tenantId_fkey" FOREIGN KEY ("storeId", "tenantId") REFERENCES "Store"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthLabel" ADD CONSTRAINT "GroundTruthLabel_datasetId_tenantId_fkey" FOREIGN KEY ("datasetId", "tenantId") REFERENCES "CalibrationDataset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthLabel" ADD CONSTRAINT "GroundTruthLabel_actualZoneId_tenantId_fkey" FOREIGN KEY ("actualZoneId", "tenantId") REFERENCES "Zone"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "ProcessingJob"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_datasetId_tenantId_fkey" FOREIGN KEY ("datasetId", "tenantId") REFERENCES "CalibrationDataset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
