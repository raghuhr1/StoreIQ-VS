import { apiRoute, ok, pageParams, paged, readJson } from "@/server/http";
import { createJob, listJobs } from "@/server/services/jobs";

export const GET = apiRoute({ permission: "job:read" }, async ({ req, ctx }) => {
  const url = new URL(req.url);
  const p = pageParams(url);
  const r = await listJobs(ctx, {
    storeId: url.searchParams.get("storeId") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    ...p,
  });
  return paged(r, p);
});

/** Create a processing job. Send an `Idempotency-Key` header to make retries of this request safe. */
export const POST = apiRoute({ permission: "job:create" }, async ({ req, ctx }) => {
  const { job, deduplicated } = await createJob(ctx, await readJson(req), req.headers.get("idempotency-key"));
  return Response.json(ok({ id: job.id, status: job.status, deduplicated }), {
    status: deduplicated ? 200 : 202,
  });
});
