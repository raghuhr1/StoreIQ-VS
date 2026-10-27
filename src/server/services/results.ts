import { Readable } from "node:stream";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { config } from "../config";
import { withTenant, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { storage } from "../storage";

export interface ResultQuery {
  classification?: "ACCEPTED" | "NEEDS_REVIEW" | "REJECTED_FROM_ZONE";
  zoneId?: string;
  reasonCode?: string;
  /** Only EPCs with at least one zone exclusion (cross-reads). */
  excluded?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

async function jobOrThrow(tx: Tx, tenantId: string, jobId: string) {
  const job = await tx.processingJob.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true, status: true, storeId: true },
  });
  if (!job) throw notFound("Job");
  return job;
}

export async function listResults(ctx: AuthContext, jobId: string, q: ResultQuery) {
  requirePermission(ctx, "results:read");
  return withTenant(ctx.tenantId, async (tx) => {
    await jobOrThrow(tx, ctx.tenantId, jobId);
    const where: Prisma.ClassificationResultWhereInput = {
      tenantId: ctx.tenantId,
      jobId,
      ...(q.classification ? { classification: q.classification } : {}),
      ...(q.zoneId
        ? q.classification === "ACCEPTED"
          ? { assignedZoneId: q.zoneId }
          : { observedZoneIds: { has: q.zoneId } }
        : {}),
      ...(q.reasonCode ? { reasonCode: q.reasonCode } : {}),
      ...(q.excluded ? { reasonCode: "MULTI_ZONE_RESOLVED" } : {}),
      ...(q.search ? { epc: { contains: q.search.trim().toUpperCase().slice(0, 64) } } : {}),
    };
    const [items, total] = await Promise.all([
      tx.classificationResult.findMany({ where, orderBy: { epc: "asc" }, take: q.limit, skip: q.offset }),
      tx.classificationResult.count({ where }),
    ]);
    return { items, total };
  });
}

/** Exceptions = review items, primary exclusions, and EPCs excluded from at least one zone. */
export async function listExceptions(
  ctx: AuthContext,
  jobId: string,
  q: Omit<ResultQuery, "classification" | "excluded">,
) {
  requirePermission(ctx, "results:read");
  return withTenant(ctx.tenantId, async (tx) => {
    await jobOrThrow(tx, ctx.tenantId, jobId);
    const where: Prisma.ClassificationResultWhereInput = {
      tenantId: ctx.tenantId,
      jobId,
      OR: [{ classification: { not: "ACCEPTED" } }, { reasonCode: "MULTI_ZONE_RESOLVED" }],
      ...(q.zoneId ? { observedZoneIds: { has: q.zoneId } } : {}),
      ...(q.reasonCode ? { reasonCode: q.reasonCode } : {}),
      ...(q.search ? { epc: { contains: q.search.trim().toUpperCase().slice(0, 64) } } : {}),
    };
    const [items, total, byReason] = await Promise.all([
      tx.classificationResult.findMany({
        where,
        orderBy: [{ requiresManualReview: "desc" }, { epc: "asc" }],
        take: q.limit,
        skip: q.offset,
      }),
      tx.classificationResult.count({ where }),
      tx.classificationResult.groupBy({
        by: ["reasonCode"],
        where: { tenantId: ctx.tenantId, jobId, OR: where.OR },
        _count: true,
      }),
    ]);
    return { items, total, byReason: byReason.map((r) => ({ reasonCode: r.reasonCode, count: r._count })) };
  });
}

export async function listObserved(
  ctx: AuthContext,
  jobId: string,
  q: { zoneId?: string; search?: string; limit: number; offset: number },
) {
  requirePermission(ctx, "results:read");
  return withTenant(ctx.tenantId, async (tx) => {
    await jobOrThrow(tx, ctx.tenantId, jobId);
    const where: Prisma.EpcZoneSummaryWhereInput = {
      tenantId: ctx.tenantId,
      jobId,
      ...(q.zoneId ? { zoneId: q.zoneId } : {}),
      ...(q.search ? { epc: { contains: q.search.trim().toUpperCase().slice(0, 64) } } : {}),
    };
    const [items, total] = await Promise.all([
      tx.epcZoneSummary.findMany({
        where,
        orderBy: [{ epc: "asc" }, { zoneId: "asc" }],
        take: q.limit,
        skip: q.offset,
      }),
      tx.epcZoneSummary.count({ where }),
    ]);
    return { items, total };
  });
}

export async function listRowErrors(ctx: AuthContext, jobId: string, q: { limit: number; offset: number }) {
  requirePermission(ctx, "results:read");
  return withTenant(ctx.tenantId, async (tx) => {
    await jobOrThrow(tx, ctx.tenantId, jobId);
    const where = { tenantId: ctx.tenantId, jobId };
    const [items, total] = await Promise.all([
      tx.rowError.findMany({ where, orderBy: { id: "asc" }, take: q.limit, skip: q.offset }),
      tx.rowError.count({ where }),
    ]);
    return { items: items.map((i) => ({ ...i, id: i.id.toString() })), total };
  });
}

/** Raw source rows for one EPC (traceability drill-down). */
export async function epcTrace(ctx: AuthContext, jobId: string, epc: string) {
  requirePermission(ctx, "results:read");
  return withTenant(ctx.tenantId, async (tx) => {
    await jobOrThrow(tx, ctx.tenantId, jobId);
    const [result, summaries, observations] = await Promise.all([
      tx.classificationResult.findFirst({ where: { tenantId: ctx.tenantId, jobId, epc } }),
      tx.epcZoneSummary.findMany({ where: { tenantId: ctx.tenantId, jobId, epc } }),
      tx.rawObservation.findMany({
        where: { tenantId: ctx.tenantId, jobId, epc },
        orderBy: [{ uploadId: "asc" }, { rowNumber: "asc" }],
        take: 500,
      }),
    ]);
    if (!result) throw notFound("EPC");
    return { result, summaries, observations: observations.map((o) => ({ ...o, id: o.id.toString() })) };
  });
}

/**
 * Authorize and audit an output download. Returns either a short-lived signed
 * URL (object storage) or a stream to proxy (local storage).
 */
export async function openOutput(ctx: AuthContext, jobId: string, kind: string) {
  requirePermission(ctx, "results:download");
  const output = await withTenant(ctx.tenantId, async (tx) => {
    const job = await jobOrThrow(tx, ctx.tenantId, jobId);
    if (job.status !== "COMPLETED")
      throw new AppError("CONFLICT", "Outputs are available once the job has completed");
    const o = await tx.jobOutput.findFirst({ where: { tenantId: ctx.tenantId, jobId, kind } });
    if (!o) throw notFound("Output file");
    await audit(tx, ctx, "OUTPUT_DOWNLOADED", { type: "JobOutput", id: o.id }, { jobId, kind });
    return o;
  });
  const url = await storage().signedDownloadUrl(
    output.storageKey,
    output.filename,
    config().DOWNLOAD_URL_TTL_SECONDS,
  );
  if (url) return { kind: "redirect" as const, url };
  const stream = await storage().getStream(output.storageKey);
  return {
    kind: "stream" as const,
    filename: output.filename,
    sizeBytes: output.sizeBytes,
    body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
  };
}
