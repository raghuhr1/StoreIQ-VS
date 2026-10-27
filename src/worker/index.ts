/**
 * Background worker: processes queued jobs and applies retention.
 *   npm run worker
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import { config } from "@/server/config";
import { disconnectDb } from "@/server/db";
import { heartbeat } from "@/server/jobs/queue";
import { runRetention } from "@/server/jobs/retention";
import { runOnce } from "@/server/jobs/worker-loop";
import { log } from "@/server/logger";

try {
  process.loadEnvFile();
} catch {
  /* env provided by the platform */
}

const workerId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lane(n: number) {
  const c = config();
  while (!stopping) {
    try {
      const worked = await runOnce(workerId);
      if (!worked) await sleep(c.WORKER_POLL_INTERVAL_MS);
    } catch (e) {
      log.error("worker lane error", { lane: n, error: e });
      await sleep(c.WORKER_POLL_INTERVAL_MS * 2);
    }
  }
}

async function main() {
  const c = config();
  log.info("worker starting", { workerId, concurrency: c.WORKER_CONCURRENCY });
  await heartbeat(workerId);
  const beat = setInterval(
    () => heartbeat(workerId).catch((e) => log.error("heartbeat failed", { error: e })),
    15_000,
  );
  const retention = async () => runRetention().catch((e) => log.error("retention failed", { error: e }));
  void retention();
  const retentionTimer = setInterval(retention, 3_600_000);
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.info("worker stopping (finishing current job)", { workerId });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await Promise.all(Array.from({ length: c.WORKER_CONCURRENCY }, (_, i) => lane(i)));
  clearInterval(beat);
  clearInterval(retentionTimer);
  await disconnectDb();
  log.info("worker stopped", { workerId });
}

main().catch((e) => {
  log.error("worker crashed", { error: e });
  process.exit(1);
});
