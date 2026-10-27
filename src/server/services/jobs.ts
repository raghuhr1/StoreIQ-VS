import { createHash } from "node:crypto";
import { z } from "zod";
import { validateMapping } from "@/engine";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { withTenant } from "../db";
import { AppError, invalid, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import { getDefaultProfile, profileVersionLabel } from "./profiles";
import { getStoreOrThrow } from "./stores";
import { fileMappingInput } from "./uploads";

export const createJobInput = z.object({
  storeId: z.string().uuid(),
  inputs: z
    .array(fileMappingInput.extend({ uploadId: z.string().uuid() }))
    .min(1)
    .max(20),
  processingProfileId: z.string().uuid().optional(),
  /** Re-run even if an identical job already exists. */
  force: z.boolean().default(false),
});

/**
 * Create a processing job. Protected against duplicate submissions by an
 * optional Idempotency-Key and by an input hash (same files + mappings +
 * profile version => the existing job is returned).
 */
export async function createJob(ctx: AuthContext, raw: unknown, idempotencyKey?: string | null) {
  requirePermission(ctx, "job:create");
  const input = createJobInput.parse(raw);
  if (idempotencyKey && !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))
    throw invalid("Invalid Idempotency-Key header");

  return withTenant(ctx.tenantId, async (tx) => {
    const store = await getStoreOrThrow(tx, ctx.tenantId, input.storeId);
    const ids = input.inputs.map((i) => i.uploadId);
    if (new Set(ids).size !== ids.length) throw invalid("The same upload is listed more than once");
    const uploads = await tx.upload.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } } });
    if (uploads.length !== ids.length) throw notFound("Upload");
    for (const u of uploads) {
      if (u.storeId !== store.id) throw invalid(`Upload ${u.originalFilename} belongs to a different store`);
      if (u.fileDeletedAt)
        throw new AppError("CONFLICT", `Upload ${u.originalFilename} was removed by the retention policy`);
    }
    const hashes = new Map<string, string>();
    for (const u of uploads) {
      const prev = hashes.get(u.sha256);
      if (prev)
        throw new AppError(
          "CONFLICT",
          `${u.originalFilename} has identical content to ${prev}; repeated uploads would double-count reads`,
        );
      hashes.set(u.sha256, u.originalFilename);
    }
    const zoneIds = new Set(
      (
        await tx.zone.findMany({ where: { storeId: store.id, tenantId: ctx.tenantId }, select: { id: true } })
      ).map((z) => z.id),
    );
    const byId = new Map(uploads.map((u) => [u.id, u]));
    for (const i of input.inputs) {
      const u = byId.get(i.uploadId)!;
      const check = validateMapping(i.mapping, Object.values(i.mapping), u.zoneId);
      if (!check.ok) throw invalid(`${u.originalFilename}: ${check.errors.join("; ")}`);
      if (Object.values(i.zoneValueMap).some((z) => !zoneIds.has(z)))
        throw invalid("Zone value map refers to an unknown zone");
    }

    const profile = input.processingProfileId
      ? await tx.processingProfile.findFirst({
          where: { id: input.processingProfileId, tenantId: ctx.tenantId },
        })
      : await getDefaultProfile(tx, ctx.tenantId);
    if (!profile) throw notFound("Processing profile");

    // Stable order => deterministic processing.
    const ordered = [...input.inputs].sort((a, b) => {
      const ua = byId.get(a.uploadId)!;
      const ub = byId.get(b.uploadId)!;
      return ua.createdAt.getTime() - ub.createdAt.getTime() || (ua.id < ub.id ? -1 : 1);
    });
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify({
          store: store.id,
          profile: profile.id,
          inputs: ordered.map((i) => [
            byId.get(i.uploadId)!.sha256,
            byId.get(i.uploadId)!.zoneId,
            i.mapping,
            i.zoneValueMap,
            i.dateFormat,
          ]),
        }),
      )
      .digest("hex");

    if (idempotencyKey) {
      const existing = await tx.processingJob.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey },
      });
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new AppError("CONFLICT", "Idempotency-Key was already used for a different request");
        return { job: existing, deduplicated: true };
      }
    }
    if (!input.force) {
      const same = await tx.processingJob.findFirst({
        where: { tenantId: ctx.tenantId, inputHash, status: { not: "FAILED" } },
        orderBy: { createdAt: "desc" },
      });
      if (same) return { job: same, deduplicated: true };
    }

    const job = await tx.processingJob.create({
      data: {
        tenantId: ctx.tenantId,
        storeId: store.id,
        idempotencyKey: idempotencyKey ?? null,
        inputHash,
        processingProfileId: profile.id,
        createdById: ctx.userId,
        inputs: {
          create: ordered.map((i) => ({
            uploadId: i.uploadId,
            mapping: { mapping: i.mapping, zoneValueMap: i.zoneValueMap, dateFormat: i.dateFormat },
          })),
        },
      },
    });
    await enqueue(tx, job.id, ctx.tenantId);
    await audit(
      tx,
      ctx,
      "JOB_CREATED",
      { type: "ProcessingJob", id: job.id },
      { storeId: store.id, uploads: ids, profile: profileVersionLabel(profile) },
    );
    return { job, deduplicated: false };
  });
}

export async function retryJob(ctx: AuthContext, jobId: string) {
  requirePermission(ctx, "job:create");
  return withTenant(ctx.tenantId, async (tx) => {
    const job = await tx.processingJob.findFirst({ where: { id: jobId, tenantId: ctx.tenantId } });
    if (!job) throw notFound("Job");
    if (job.status !== "FAILED") throw new AppError("CONFLICT", "Only failed jobs can be retried");
    const updated = await tx.processingJob.update({
      where: { id: jobId },
      data: { status: "QUEUED", progress: 0, stage: null, errorMessage: null },
    });
    await enqueue(tx, jobId, ctx.tenantId);
    await audit(tx, ctx, "JOB_RETRIED", { type: "ProcessingJob", id: jobId });
    return updated;
  });
}

export async function listJobs(
  ctx: AuthContext,
  q: { storeId?: string; status?: string; limit: number; offset: number },
) {
  requirePermission(ctx, "job:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const where = {
      tenantId: ctx.tenantId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
    };
    const [items, total] = await Promise.all([
      tx.processingJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
        skip: q.offset,
        include: {
          store: { select: { name: true, code: true } },
          profile: { select: { name: true, version: true, rulesVersion: true } },
        },
      }),
      tx.processingJob.count({ where }),
    ]);
    return { items: items.map(({ idempotencyKey: _k, ...j }) => j), total };
  });
}

export async function getJob(ctx: AuthContext, jobId: string) {
  requirePermission(ctx, "job:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const job = await tx.processingJob.findFirst({
      where: { id: jobId, tenantId: ctx.tenantId },
      include: {
        store: { include: { zones: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] } } },
        profile: true,
        inputs: { include: { upload: true } },
        outputs: { orderBy: { filename: "asc" } },
        metrics: true,
        sessions: { orderBy: { externalId: "asc" } },
      },
    });
    if (!job) throw notFound("Job");
    const { idempotencyKey: _k, ...rest } = job;
    return {
      ...rest,
      profileVersion: profileVersionLabel(job.profile),
      inputs: job.inputs.map((i) => ({
        uploadId: i.uploadId,
        mapping: i.mapping,
        upload: { ...i.upload, storageKey: undefined },
      })),
      outputs: job.outputs.map(({ storageKey: _s, ...o }) => o),
    };
  });
}
