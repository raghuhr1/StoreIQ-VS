import { z } from "zod";
import {
  evaluate,
  normalizeEpc,
  readCsv,
  resolveProfile,
  resolveZoneValue,
  sniffCsv,
  suggestCalibration,
  type AggregationResult,
  type ClassificationResult as EngineResult,
} from "@/engine";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { withTenant } from "../db";
import { AppError, invalid, notFound } from "../errors";
import { getDefaultProfile } from "./profiles";
import { getStoreOrThrow } from "./stores";
import { toZoneRefs } from "./uploads";

const MAX_LABEL_BYTES = 20 * 1024 * 1024;
const MAX_LABELS = 200_000;
const CATEGORIES = ["KNOWN_LOCATION", "BOUNDARY", "CROSS_READ_EXAMPLE", "AMBIGUOUS"] as const;
type Category = (typeof CATEGORIES)[number];

export const datasetInput = z.object({
  storeId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(["CALIBRATION", "GROUND_TRUTH"]),
  jobId: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * Create a labeled dataset from CSV text with columns:
 *   epc, actual_zone [, category] [, notes]
 * Labels must come from physical verification, never from engine output.
 */
export async function createDataset(ctx: AuthContext, raw: unknown, csvText: string) {
  requirePermission(ctx, "calibration:write");
  const input = datasetInput.parse(raw);
  const bytes = Buffer.from(csvText, "utf8");
  if (bytes.length > MAX_LABEL_BYTES)
    throw new AppError("PAYLOAD_TOO_LARGE", "Label file is too large (20 MB maximum)");
  const sniff = sniffCsv(bytes);
  if (!sniff.ok) throw new AppError("UNSUPPORTED_FILE", sniff.message);

  return withTenant(
    ctx.tenantId,
    async (tx) => {
      const store = await getStoreOrThrow(tx, ctx.tenantId, input.storeId);
      if (input.jobId) {
        const job = await tx.processingJob.findFirst({ where: { id: input.jobId, tenantId: ctx.tenantId } });
        if (!job || job.storeId !== store.id) throw notFound("Job");
      }
      const zones = toZoneRefs(
        await tx.zone.findMany({ where: { storeId: store.id, tenantId: ctx.tenantId } }),
      );
      const profile = resolveProfile((await getDefaultProfile(tx, ctx.tenantId)).config);

      const errors: { rowNumber: number; message: string }[] = [];
      const labels = new Map<
        string,
        { epc: string; actualZoneId: string; category: Category; notes: string | null }
      >();
      let idx: Record<string, number> = {};
      const source = (async function* () {
        yield bytes;
      })();
      for await (const item of readCsv(source, sniff.sniff.delimiter)) {
        if (item.kind === "header") {
          const lower = item.headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
          idx = {
            epc: lower.indexOf("epc"),
            zone: lower.findIndex((h) => h === "actualzone" || h === "zone"),
            category: lower.indexOf("category"),
            notes: lower.indexOf("notes"),
          };
          if (idx.epc < 0 || idx.zone < 0) throw invalid("Label file needs 'epc' and 'actual_zone' columns");
          continue;
        }
        if (item.kind === "malformed") {
          errors.push({ rowNumber: item.rowNumber, message: item.message });
          continue;
        }
        const r = item.record;
        const n = normalizeEpc(r[idx.epc] ?? "", profile.epc);
        const zoneId = resolveZoneValue(r[idx.zone] ?? "", zones, {});
        const cat = idx.category >= 0 ? (r[idx.category] ?? "").trim().toUpperCase() : "";
        if (!n.valid) errors.push({ rowNumber: item.rowNumber, message: `Invalid EPC (${n.issue})` });
        else if (!zoneId)
          errors.push({
            rowNumber: item.rowNumber,
            message: `Unknown zone "${(r[idx.zone] ?? "").slice(0, 40)}"`,
          });
        else if (cat && !(CATEGORIES as readonly string[]).includes(cat))
          errors.push({ rowNumber: item.rowNumber, message: `Unknown category "${cat.slice(0, 40)}"` });
        else if (labels.has(n.epc) && labels.get(n.epc)!.actualZoneId !== zoneId)
          errors.push({
            rowNumber: item.rowNumber,
            message: `EPC ${n.epc} is labeled with two different zones`,
          });
        else
          labels.set(n.epc, {
            epc: n.epc,
            actualZoneId: zoneId,
            category: (cat || "KNOWN_LOCATION") as Category,
            notes: idx.notes >= 0 ? (r[idx.notes] ?? "").slice(0, 200) || null : null,
          });
        if (labels.size > MAX_LABELS) throw invalid(`At most ${MAX_LABELS} labels per dataset`);
      }
      if (errors.length) throw invalid(`${errors.length} label row(s) are invalid`, errors.slice(0, 100));
      if (labels.size === 0) throw invalid("The label file contains no labels");

      const dataset = await tx.calibrationDataset.create({
        data: {
          tenantId: ctx.tenantId,
          storeId: store.id,
          name: input.name,
          purpose: input.purpose,
          jobId: input.jobId ?? null,
          notes: input.notes,
          createdById: ctx.userId,
          labelCount: labels.size,
        },
      });
      const all = [...labels.values()];
      for (let i = 0; i < all.length; i += 5000)
        await tx.groundTruthLabel.createMany({
          data: all.slice(i, i + 5000).map((l) => ({ ...l, tenantId: ctx.tenantId, datasetId: dataset.id })),
        });
      await audit(
        tx,
        ctx,
        "DATASET_CREATED",
        { type: "CalibrationDataset", id: dataset.id },
        { purpose: input.purpose, labels: labels.size },
      );
      return dataset;
    },
    { timeoutMs: 300_000 },
  );
}

export async function listDatasets(ctx: AuthContext, storeId?: string) {
  requirePermission(ctx, "calibration:read");
  return withTenant(ctx.tenantId, (tx) =>
    tx.calibrationDataset.findMany({
      where: { tenantId: ctx.tenantId, ...(storeId ? { storeId } : {}) },
      orderBy: { createdAt: "desc" },
      include: { store: { select: { name: true, code: true } } },
    }),
  );
}

async function loadEngineResults(
  tx: Prisma.TransactionClient,
  tenantId: string,
  jobId: string,
): Promise<EngineResult[]> {
  const out: EngineResult[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await tx.classificationResult.findMany({
      where: { tenantId, jobId },
      orderBy: { id: "asc" },
      take: 10_000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, epc: true, observedZoneIds: true, classification: true, assignedZoneId: true },
    });
    for (const r of page) out.push(r as unknown as EngineResult);
    if (page.length < 10_000) return out;
    cursor = page[page.length - 1].id;
  }
}

/**
 * Evaluate a completed job against a GROUND_TRUTH dataset. Calibration
 * datasets are refused, and evaluating a job that was used to tune the
 * profile is flagged as in-sample (not a valid holdout estimate).
 */
export async function evaluateJob(ctx: AuthContext, jobId: string, datasetId: string) {
  requirePermission(ctx, "calibration:write");
  return withTenant(
    ctx.tenantId,
    async (tx) => {
      const job = await tx.processingJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId },
        include: { profile: true, store: { include: { zones: true } } },
      });
      if (!job) throw notFound("Job");
      if (job.status !== "COMPLETED") throw new AppError("CONFLICT", "Only completed jobs can be evaluated");
      const dataset = await tx.calibrationDataset.findFirst({
        where: { id: datasetId, tenantId: ctx.tenantId },
      });
      if (!dataset) throw notFound("Dataset");
      if (dataset.storeId !== job.storeId) throw invalid("Dataset and job belong to different stores");
      if (dataset.purpose !== "GROUND_TRUTH")
        throw invalid(
          "Calibration datasets are reserved for tuning. Upload a separate ground-truth dataset for evaluation.",
        );
      const labels = await tx.groundTruthLabel.findMany({
        where: { tenantId: ctx.tenantId, datasetId },
        select: { epc: true, actualZoneId: true, category: true },
      });
      const results = await loadEngineResults(tx, ctx.tenantId, jobId);
      const metrics = evaluate(results, labels, toZoneRefs(job.store.zones));
      const tuned = job.profile.tunedFromJobIds;
      const inSample = tuned.includes(jobId) || (dataset.jobId !== null && tuned.includes(dataset.jobId));
      const ev = await tx.evaluation.create({
        data: {
          tenantId: ctx.tenantId,
          jobId,
          datasetId,
          inSample,
          metrics: metrics as unknown as Prisma.InputJsonValue,
          createdById: ctx.userId,
        },
      });
      await audit(
        tx,
        ctx,
        "JOB_EVALUATED",
        { type: "Evaluation", id: ev.id },
        { jobId, datasetId, inSample, labeled: metrics.labeledCount },
      );
      return { ...ev, metrics };
    },
    { timeoutMs: 300_000 },
  );
}

export async function listEvaluations(ctx: AuthContext, jobId?: string) {
  requirePermission(ctx, "calibration:read");
  return withTenant(ctx.tenantId, (tx) =>
    tx.evaluation.findMany({
      where: { tenantId: ctx.tenantId, ...(jobId ? { jobId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { dataset: { select: { name: true, purpose: true, labelCount: true } } },
    }),
  );
}

/** Advisory threshold suggestions from a CALIBRATION dataset linked to a job. */
export async function calibrationSuggestions(ctx: AuthContext, datasetId: string) {
  requirePermission(ctx, "calibration:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const dataset = await tx.calibrationDataset.findFirst({
      where: { id: datasetId, tenantId: ctx.tenantId },
    });
    if (!dataset) throw notFound("Dataset");
    if (dataset.purpose !== "CALIBRATION")
      throw invalid("Suggestions are computed from calibration datasets only");
    if (!dataset.jobId)
      throw invalid("Link the calibration dataset to the scan job it labels to compute suggestions");
    const zones = toZoneRefs(
      await tx.zone.findMany({ where: { storeId: dataset.storeId, tenantId: ctx.tenantId } }),
    );
    const labels = await tx.groundTruthLabel.findMany({
      where: { tenantId: ctx.tenantId, datasetId },
      select: { epc: true, actualZoneId: true },
    });
    const summaries = await tx.epcZoneSummary.findMany({
      where: { tenantId: ctx.tenantId, jobId: dataset.jobId, epc: { in: labels.map((l) => l.epc) } },
      select: { epc: true, zoneId: true, medianRssi: true },
      orderBy: [{ epc: "asc" }, { zoneId: "asc" }],
    });
    type Agg = AggregationResult["epcs"][number];
    const byEpc = new Map<string, Agg>();
    for (const s of summaries) {
      if (!byEpc.has(s.epc))
        byEpc.set(s.epc, { epc: s.epc, epcRaw: s.epc, epcValid: true, epcIssue: null, zones: [] });
      const m = s.medianRssi;
      byEpc.get(s.epc)!.zones.push({
        zoneId: s.zoneId,
        rssi: m === null ? null : { count: 1, median: m, p25: m, p75: m, min: m, max: m },
      } as Agg["zones"][number]);
    }
    const agg = { epcs: [...byEpc.values()] } as AggregationResult;
    return { datasetId, jobId: dataset.jobId, ...suggestCalibration(agg, labels, zones) };
  });
}
