import type { JobQueue } from "@/generated/prisma/client";
import { config } from "../config";
import { db, type Tx } from "../db";

/**
 * PostgreSQL-backed work queue. Enqueue happens in the same transaction that
 * creates the job, so a job can never exist without its queue entry.
 */
export async function enqueue(tx: Tx, jobId: string, tenantId: string) {
  await tx.jobQueue.upsert({
    where: { jobId },
    create: { jobId, tenantId },
    update: {
      status: "PENDING",
      attempts: 0,
      runAfter: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

/**
 * Claim the next runnable item. Items locked by a worker that stopped
 * heart-beating for longer than the job timeout are reclaimed.
 */
export async function claimNext(workerId: string): Promise<JobQueue | null> {
  const staleSeconds = config().JOB_TIMEOUT_SECONDS + 120;
  const rows = await db().$queryRaw<JobQueue[]>`
    UPDATE "JobQueue" SET "status" = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId},
      "attempts" = "attempts" + 1, "updatedAt" = now()
    WHERE "id" = (
      SELECT "id" FROM "JobQueue"
      WHERE ("status" = 'PENDING' AND "runAfter" <= now())
         OR ("status" = 'RUNNING' AND "lockedAt" < now() - make_interval(secs => ${staleSeconds}))
      ORDER BY "runAfter", "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ?? null;
}

/** Keep the lock fresh while a long job runs. */
export async function touch(id: string, workerId: string) {
  await db().jobQueue.updateMany({ where: { id, lockedBy: workerId }, data: { lockedAt: new Date() } });
}

export async function complete(id: string) {
  await db().jobQueue.update({ where: { id }, data: { status: "DONE", lockedAt: null, lastError: null } });
}

/** Returns true when the item will be retried. */
export async function fail(item: JobQueue, error: string, retryable: boolean): Promise<boolean> {
  const retry = retryable && item.attempts < item.maxAttempts;
  await db().jobQueue.update({
    where: { id: item.id },
    data: {
      status: retry ? "PENDING" : "FAILED",
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 1000),
      runAfter: new Date(Date.now() + (retry ? 2 ** item.attempts * 15_000 : 0)),
    },
  });
  return retry;
}

export async function heartbeat(workerId: string) {
  await db().workerHeartbeat.upsert({
    where: { workerId },
    create: { workerId },
    update: { lastBeatAt: new Date() },
  });
}

export async function queueDepth() {
  return db().jobQueue.count({ where: { status: { in: ["PENDING", "RUNNING"] } } });
}
