import { apiRoute, ok } from "@/server/http";
import { getJob } from "@/server/services/jobs";

export const GET = apiRoute<{ jobId: string }>({ permission: "job:read" }, async ({ ctx, params }) =>
  ok(await getJob(ctx, params.jobId)),
);
