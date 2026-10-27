import { db } from "@/server/db";
import { queueDepth } from "@/server/jobs/queue";
import { storage } from "@/server/storage";

export const dynamic = "force-dynamic";

/** Readiness: database, storage and worker heartbeat. Reveals no configuration details. */
export async function GET() {
  const checks: Record<string, "ok" | "fail" | "stale"> = {};
  let ready = true;
  try {
    await db().$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "fail";
    ready = false;
  }
  try {
    await storage().check();
    checks.storage = "ok";
  } catch {
    checks.storage = "fail";
    ready = false;
  }
  let depth: number | null = null;
  try {
    const beat = await db().workerHeartbeat.findFirst({ orderBy: { lastBeatAt: "desc" } });
    checks.worker = beat && Date.now() - beat.lastBeatAt.getTime() < 60_000 ? "ok" : "stale";
    depth = await queueDepth();
  } catch {
    checks.worker = "fail";
  }
  return Response.json(
    { status: ready ? "ready" : "not_ready", checks, queueDepth: depth },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
