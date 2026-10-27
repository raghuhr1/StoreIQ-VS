import type { JobQueue } from "@/generated/prisma/client";
import { AppError } from "../errors";
import { log } from "../logger";
import { JobInputError, markJobFailed, processJob } from "./processor";
import { claimNext, complete, fail } from "./queue";

/** Claim and run a single queue item. Returns false when the queue is empty. */
export async function runOnce(workerId: string): Promise<boolean> {
  const item: JobQueue | null = await claimNext(workerId);
  if (!item) return false;
  try {
    await processJob(item, workerId);
    await complete(item.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const retryable = !(e instanceof JobInputError || e instanceof AppError);
    const willRetry = await fail(item, message, retryable);
    await markJobFailed(
      item.tenantId,
      item.jobId,
      retryable ? `Processing error: ${message}` : message,
      willRetry,
    ).catch((err) => log.error("could not record job failure", { jobId: item.jobId, error: err }));
    log.warn("job failed", {
      jobId: item.jobId,
      tenantId: item.tenantId,
      retryable,
      willRetry,
      error: message,
    });
  }
  return true;
}
