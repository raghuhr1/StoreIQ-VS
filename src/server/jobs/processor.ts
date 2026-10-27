import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import {
  buildExports,
  EngineRun,
  EXPORT_SCHEMA_VERSION,
  readCsv,
  resolveProfile,
  validateMapping,
  type CsvDelimiter,
  type Observation,
  type RowIssue,
} from "@/engine";
import type { JobQueue, Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import { config } from "../config";
import { withTenant } from "../db";
import { log } from "../logger";
import { objectKey, storage } from "../storage";
import { profileVersionLabel } from "../services/profiles";
import { buildFileContext, fileMappingInput, toZoneRefs } from "../services/uploads";
import { touch } from "./queue";

const BATCH = 5000;

/** Failure caused by the input or configuration; retrying cannot fix it. */
export class JobInputError extends Error {}

async function setStage(tenantId: string, jobId: string, data: Prisma.ProcessingJobUpdateInput) {
  await withTenant(tenantId, (tx) => tx.processingJob.update({ where: { id: jobId }, data }));
}

/**
 * Process one queued job. Ownership is re-validated inside a tenant-scoped
 * transaction: the queue entry's tenant must own the job, otherwise RLS hides it.
 */
export async function processJob(item: JobQueue, workerId: string) {
  const { jobId, tenantId } = item;
  const c = config();
  const started = Date.now();

  const job = await withTenant(tenantId, (tx) =>
    tx.processingJob.findFirst({
      where: { id: jobId, tenantId },
      include: {
        inputs: { include: { upload: true } },
        profile: true,
        store: {
          include: {
            zones: { where: { active: true } },
            relationships: true,
            anchors: { where: { active: true } },
          },
        },
      },
    }),
  );
  if (!job) throw new JobInputError("Job not found for the queued tenant (ownership check failed)");
  if (job.inputs.some((i) => i.upload.tenantId !== tenantId || i.upload.storeId !== job.storeId))
    throw new JobInputError("Input ownership check failed");

  // Idempotent restart: remove any partial results from a previous attempt.
  await withTenant(
    tenantId,
    async (tx) => {
      const where = { jobId, tenantId };
      await tx.rawObservation.deleteMany({ where });
      await tx.rowError.deleteMany({ where });
      await tx.epcZoneSummary.deleteMany({ where });
      await tx.classificationResult.deleteMany({ where });
      await tx.jobOutput.deleteMany({ where });
      await tx.processingMetrics.deleteMany({ where });
      await tx.scanSession.deleteMany({ where });
      await tx.processingJob.update({
        where: { id: jobId },
        data: {
          status: "PARSING",
          stage: "Parsing input files",
          progress: 1,
          startedAt: new Date(),
          completedAt: null,
          errorMessage: null,
          attempt: { increment: 1 },
        },
      });
    },
    { timeoutMs: 300_000 },
  );

  const profile = resolveProfile(job.profile.config);
  const zones = toZoneRefs(job.store.zones);
  const engine = new EngineRun({
    profile,
    zones,
    relationships: job.store.relationships.map((r) => ({
      fromZoneId: r.fromZoneId,
      toZoneId: r.toZoneId,
      relation: r.relation,
    })),
    anchors: job.store.anchors.map((a) => ({ epc: a.epc, zoneId: a.zoneId })),
  });

  let obsBatch: Prisma.RawObservationCreateManyInput[] = [];
  let errBatch: Prisma.RowErrorCreateManyInput[] = [];
  let storedErrors = 0;
  const flush = async (force = false) => {
    if (!force && obsBatch.length < BATCH && errBatch.length < BATCH) return;
    const o = obsBatch;
    const e = errBatch;
    obsBatch = [];
    errBatch = [];
    if (o.length || e.length)
      await withTenant(tenantId, async (tx) => {
        if (o.length) await tx.rawObservation.createMany({ data: o });
        if (e.length) await tx.rowError.createMany({ data: e });
      });
  };
  const recordIssues = (issues: RowIssue[]) => {
    for (const i of issues) {
      if (storedErrors >= c.MAX_STORED_ROW_ERRORS) return;
      storedErrors++;
      errBatch.push({
        tenantId,
        jobId,
        uploadId: i.uploadId,
        rowNumber: i.rowNumber,
        code: i.code,
        message: `[${i.severity}] ${i.message}`.slice(0, 500),
        field: i.field ?? null,
      });
    }
  };
  const recordObservation = (o: Observation, duplicate: boolean, anchor: boolean) =>
    obsBatch.push({
      tenantId,
      jobId,
      uploadId: o.uploadId,
      rowNumber: o.rowNumber,
      epcRaw: o.epcRaw,
      epc: o.epc,
      zoneId: o.zoneId,
      sessionKey: o.sessionKey,
      observedAt: o.timestamp === null ? null : new Date(o.timestamp),
      rssi: o.rssi,
      readCount: o.readCount,
      phase: o.phase,
      readerId: o.readerId,
      antennaId: o.antennaId,
      isAnchor: anchor,
      duplicate,
    });

  const totalBytes = job.inputs.reduce((n, i) => n + i.upload.sizeBytes, 0) || 1;
  let bytesRead = 0;
  let lastProgressAt = 0;
  for (const input of job.inputs) {
    const upload = input.upload;
    if (upload.fileDeletedAt)
      throw new JobInputError(`Source file ${upload.originalFilename} was removed by the retention policy`);
    const m = fileMappingInput.parse(input.mapping);
    const file = buildFileContext(upload, job.store.timeZone, m);
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        bytesRead += chunk.length;
        cb(null, chunk);
      },
    });
    const src = (await storage().getStream(upload.storageKey)).pipe(counter);
    for await (const it of readCsv(src, upload.delimiter as CsvDelimiter)) {
      if (it.kind === "header") {
        const check = validateMapping(m.mapping, it.headers, upload.zoneId);
        if (!check.ok) throw new JobInputError(`${upload.originalFilename}: ${check.errors.join("; ")}`);
        engine.beginFile(file, it.headers);
        continue;
      }
      if (engine.rowStats.inputRowCount >= c.MAX_ROWS_PER_JOB)
        throw new JobInputError(`Input exceeds the ${c.MAX_ROWS_PER_JOB.toLocaleString()} row limit per job`);
      if (it.kind === "malformed") recordIssues([engine.addMalformed(upload.id, it.rowNumber, it.message)]);
      else {
        const out = engine.addRecord(it.record, it.rowNumber);
        recordIssues(out.issues);
        if (out.observation) recordObservation(out.observation, out.duplicate, out.anchor);
      }
      await flush();
      if (Date.now() - lastProgressAt > 2000) {
        lastProgressAt = Date.now();
        if (Date.now() - started > c.JOB_TIMEOUT_SECONDS * 1000)
          throw new JobInputError("Processing timed out");
        await setStage(tenantId, jobId, {
          progress: Math.min(69, 1 + Math.floor((bytesRead / totalBytes) * 68)),
          rowsProcessed: engine.rowStats.inputRowCount,
        });
        await touch(item.id, workerId);
      }
    }
  }
  await flush(true);

  const rs = engine.rowStats;
  if (rs.inputFileCount !== job.inputs.length)
    throw new JobInputError("One or more input files have no header row");
  if (rs.validRowCount === 0)
    throw new JobInputError("No valid rows were found. Check the column mapping and zone assignments.");
  if (rs.invalidRowCount / Math.max(1, rs.inputRowCount) > profile.invalidRows.maxInvalidRowRatio)
    throw new JobInputError(
      `${rs.invalidRowCount} of ${rs.inputRowCount} rows are invalid (limit ${Math.round(profile.invalidRows.maxInvalidRowRatio * 100)}%). The column mapping is probably wrong.`,
    );

  await setStage(tenantId, jobId, {
    status: "CLASSIFYING",
    stage: "Classifying EPCs",
    progress: 70,
    rowsProcessed: rs.inputRowCount,
  });
  const out = engine.finish();
  const zoneIdSet = new Set(zones.map((z) => z.id));

  // Persist summaries and classifications in batches.
  const sessionRows = out.aggregation.sessions.map((s) => ({
    tenantId,
    storeId: job.storeId,
    jobId,
    uploadId: s.uploadId,
    externalId: s.externalId,
    zoneId: s.zoneIds.length === 1 && zoneIdSet.has(s.zoneIds[0]) ? s.zoneIds[0] : null,
    startedAt: s.startedAt === null ? null : new Date(s.startedAt),
    endedAt: s.endedAt === null ? null : new Date(s.endedAt),
    observationCount: s.rowCount,
    uniqueEpcCount: s.uniqueEpcCount,
  }));
  await withTenant(tenantId, (tx) => tx.scanSession.createMany({ data: sessionRows }));

  const summaries: Prisma.EpcZoneSummaryCreateManyInput[] = [];
  for (const e of out.aggregation.epcs)
    for (const z of e.zones)
      summaries.push({
        tenantId,
        jobId,
        epc: e.epc,
        zoneId: z.zoneId,
        rowCount: z.rowCount,
        rawReadCount: z.rawReadCount,
        readCountComplete: z.readCountComplete,
        windowCount: z.windowCount,
        sessionCount: z.sessionKeys.length,
        firstSeen: z.firstSeen === null ? null : new Date(z.firstSeen),
        lastSeen: z.lastSeen === null ? null : new Date(z.lastSeen),
        medianRssi: z.rssi?.median ?? null,
        p25Rssi: z.rssi?.p25 ?? null,
        p75Rssi: z.rssi?.p75 ?? null,
        rssiCount: z.rssi?.count ?? 0,
        readerIds: z.readerIds,
        antennaIds: z.antennaIds,
        sessionKeys: z.sessionKeys,
        phaseAvailable: z.phaseAvailable,
        dataQualityStatus: z.dataQualityStatus,
      });
  for (let i = 0; i < summaries.length; i += BATCH)
    await withTenant(tenantId, (tx) => tx.epcZoneSummary.createMany({ data: summaries.slice(i, i + BATCH) }));
  await setStage(tenantId, jobId, { progress: 80 });

  for (let i = 0; i < out.results.length; i += BATCH) {
    const chunk = out.results.slice(i, i + BATCH).map((r) => ({
      tenantId,
      jobId,
      epc: r.epc,
      epcRaw: r.epcRaw,
      observedZoneIds: r.observedZoneIds,
      classification: r.classification,
      assignedZoneId: r.assignedZoneId,
      confidenceScore: r.confidenceScore,
      confidenceType: r.confidenceType,
      confidenceBand: r.confidenceBand,
      reasonCode: r.reasonCode,
      reasonDescription: r.reasonDescription,
      recommendedAction: r.recommendedAction,
      evidenceAvailable: r.evidenceAvailable,
      rulesFired: r.rulesFired,
      requiresManualReview: r.requiresManualReview,
      zoneDispositions: r.zoneDispositions as unknown as Prisma.InputJsonValue,
      evidence: {
        components: r.components,
        suggestedZoneId: r.suggestedZoneId,
      } as unknown as Prisma.InputJsonValue,
    }));
    await withTenant(tenantId, (tx) => tx.classificationResult.createMany({ data: chunk }));
    await touch(item.id, workerId);
  }

  await setStage(tenantId, jobId, { status: "EXPORTING", stage: "Generating output files", progress: 90 });
  const completedAt = new Date();
  const profileVersion = profileVersionLabel(job.profile);
  const files = buildExports({
    jobId,
    storeId: job.storeId,
    profileVersion,
    zones,
    aggregation: out.aggregation,
    results: out.results,
    metrics: out.metrics,
    rowStats: out.rowStats,
    processingStatus: "COMPLETED",
    createdAt: job.createdAt.getTime(),
    completedAt: completedAt.getTime(),
  });
  const outputs: Prisma.JobOutputCreateManyInput[] = [];
  for (const f of files) {
    const body = Buffer.from(f.content, "utf8");
    const key = objectKey("tenants", tenantId, "jobs", jobId, "outputs", f.filename);
    await storage().putBuffer(key, body, "text/csv; charset=utf-8");
    outputs.push({
      tenantId,
      jobId,
      kind: f.kind,
      filename: f.filename,
      storageKey: key,
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      rowCount: f.rowCount,
      schemaVersion: EXPORT_SCHEMA_VERSION,
    });
  }

  const warnings = [
    ...out.aggregation.warnings,
    ...Object.entries(out.rowStats.issueCounts).map(([code, n]) => ({
      code: `ROWS_${code}`,
      message: `${n} row issue(s): ${code}`,
    })),
  ];
  await withTenant(tenantId, async (tx) => {
    await tx.jobOutput.createMany({ data: outputs });
    await tx.processingMetrics.create({
      data: {
        tenantId,
        jobId,
        summary: {
          ...out.metrics,
          rowStats: out.rowStats,
          evidence: out.aggregation.stats,
          profileVersion,
          zoneCodes: Object.fromEntries(zones.map((z) => [z.id, z.code])),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.processingJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        stage: null,
        progress: 100,
        completedAt,
        inputRowCount: out.rowStats.inputRowCount,
        rowsProcessed: out.rowStats.inputRowCount,
        uniqueEpcCount: out.metrics.uniqueEpcCount,
        warnings: warnings as unknown as Prisma.InputJsonValue,
      },
    });
    await audit(
      tx,
      { tenantId, userId: null },
      "JOB_COMPLETED",
      { type: "ProcessingJob", id: jobId },
      {
        uniqueEpcCount: out.metrics.uniqueEpcCount,
        reviewCount: out.metrics.reviewCount,
        ms: Date.now() - started,
      },
    );
  });
  log.info("job completed", {
    jobId,
    tenantId,
    rows: out.rowStats.inputRowCount,
    epcs: out.metrics.uniqueEpcCount,
    ms: Date.now() - started,
  });
}

/** Record a failure on the job (called by the worker). */
export async function markJobFailed(tenantId: string, jobId: string, message: string, willRetry: boolean) {
  await withTenant(tenantId, async (tx) => {
    const job = await tx.processingJob.findFirst({ where: { id: jobId, tenantId } });
    if (!job) return;
    await tx.processingJob.update({
      where: { id: jobId },
      data: willRetry
        ? { status: "QUEUED", stage: "Waiting to retry after an error", errorMessage: message.slice(0, 1000) }
        : { status: "FAILED", stage: null, errorMessage: message.slice(0, 1000) },
    });
    if (!willRetry)
      await audit(
        tx,
        { tenantId, userId: null },
        "JOB_FAILED",
        { type: "ProcessingJob", id: jobId },
        { message: message.slice(0, 300) },
      );
  });
}
