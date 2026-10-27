import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { withTenant } from "../db";

interface MetricsSummary {
  acceptedByZone?: Record<string, number>;
  reviewCount?: number;
  multiZoneEpcCount?: number;
  multiZoneOverlapRate?: number | null;
  rejectedFromZoneCount?: number;
  uniqueEpcCount?: number;
}

export async function dashboard(ctx: AuthContext) {
  requirePermission(ctx, "dashboard:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const t = { tenantId: ctx.tenantId };
    const [storeCount, byStatus, recentJobs, pendingUploads, epcTotal, stores, evaluations] =
      await Promise.all([
        tx.store.count({ where: t }),
        tx.processingJob.groupBy({ by: ["status"], where: t, _count: true }),
        tx.processingJob.findMany({
          where: t,
          orderBy: { createdAt: "desc" },
          take: 8,
          include: { store: { select: { name: true } } },
        }),
        tx.upload.count({ where: { ...t, status: "RECEIVED", jobInputs: { none: {} } } }),
        tx.processingJob.aggregate({ where: { ...t, status: "COMPLETED" }, _sum: { uniqueEpcCount: true } }),
        tx.store.findMany({ where: t, select: { id: true, name: true }, orderBy: { name: "asc" } }),
        tx.evaluation.findMany({
          where: t,
          orderBy: { createdAt: "desc" },
          take: 3,
          include: { dataset: { select: { name: true } } },
        }),
      ]);
    // Latest completed job per store drives the "current inventory" tiles.
    const latest = await Promise.all(
      stores.map(async (s) => {
        const job = await tx.processingJob.findFirst({
          where: { ...t, storeId: s.id, status: "COMPLETED" },
          orderBy: { completedAt: "desc" },
          include: { metrics: true },
        });
        return {
          store: s,
          job: job
            ? {
                id: job.id,
                completedAt: job.completedAt,
                metrics: (job.metrics?.summary ?? {}) as MetricsSummary,
              }
            : null,
        };
      }),
    );
    const statusCount = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
    return {
      storeCount,
      jobs: {
        completed: statusCount("COMPLETED"),
        failed: statusCount("FAILED"),
        inProgress:
          statusCount("QUEUED") +
          statusCount("PARSING") +
          statusCount("CLASSIFYING") +
          statusCount("EXPORTING"),
      },
      pendingUploads,
      totalUniqueEpcsProcessed: epcTotal._sum.uniqueEpcCount ?? 0,
      recentJobs: recentJobs.map((j) => ({
        id: j.id,
        status: j.status,
        store: j.store.name,
        createdAt: j.createdAt,
        uniqueEpcCount: j.uniqueEpcCount,
        progress: j.progress,
      })),
      latestByStore: latest,
      evaluations: evaluations.map((e) => ({
        id: e.id,
        jobId: e.jobId,
        dataset: e.dataset.name,
        inSample: e.inSample,
        createdAt: e.createdAt,
        metrics: e.metrics,
      })),
    };
  });
}
