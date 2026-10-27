import { audit } from "../audit";
import { config } from "../config";
import { db, withTenant } from "../db";
import { log } from "../logger";
import { storage } from "../storage";

/**
 * Apply retention: delete source upload files and raw observations older than
 * the configured number of days. Results, summaries, outputs and audit events
 * are kept. Runs per tenant inside its own RLS context.
 */
export async function runRetention(now = new Date()) {
  const c = config();
  const tenants = await db().tenant.findMany({ select: { id: true } });
  for (const { id: tenantId } of tenants) {
    let files = 0;
    let rows = 0;
    if (c.RETENTION_UPLOAD_FILES_DAYS > 0) {
      const cutoff = new Date(now.getTime() - c.RETENTION_UPLOAD_FILES_DAYS * 86_400_000);
      const old = await withTenant(tenantId, (tx) =>
        tx.upload.findMany({
          where: { tenantId, createdAt: { lt: cutoff }, fileDeletedAt: null },
          take: 1000,
        }),
      );
      for (const u of old) {
        await storage().delete(u.storageKey);
        await withTenant(tenantId, (tx) =>
          tx.upload.update({ where: { id: u.id }, data: { fileDeletedAt: now, status: "FILE_DELETED" } }),
        );
        files++;
      }
    }
    if (c.RETENTION_RAW_OBSERVATIONS_DAYS > 0) {
      const cutoff = new Date(now.getTime() - c.RETENTION_RAW_OBSERVATIONS_DAYS * 86_400_000);
      rows = await withTenant(
        tenantId,
        async (tx) => {
          const jobs = await tx.processingJob.findMany({
            where: { tenantId, completedAt: { lt: cutoff } },
            select: { id: true },
          });
          if (!jobs.length) return 0;
          return (
            await tx.rawObservation.deleteMany({ where: { tenantId, jobId: { in: jobs.map((j) => j.id) } } })
          ).count;
        },
        { timeoutMs: 600_000 },
      );
    }
    if (files || rows)
      await withTenant(tenantId, (tx) =>
        audit(
          tx,
          { tenantId, userId: null },
          "RETENTION_CLEANUP",
          {},
          { filesDeleted: files, rawObservationsDeleted: rows },
        ),
      );
    if (files || rows) log.info("retention cleanup", { tenantId, files, rows });
  }
}
