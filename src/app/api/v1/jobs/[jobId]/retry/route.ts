import { apiRoute, ok } from "@/server/http";
import { retryJob } from "@/server/services/jobs";

export const POST = apiRoute<{ jobId: string }>({ permission: "job:create" }, async ({ ctx, params }) => {
  const j = await retryJob(ctx, params.jobId);
  return ok({ id: j.id, status: j.status });
});
