import { apiRoute, pageParams, paged } from "@/server/http";
import { listRowErrors } from "@/server/services/results";

export const GET = apiRoute<{ jobId: string }>(
  { permission: "results:read" },
  async ({ req, ctx, params }) => {
    const p = pageParams(new URL(req.url));
    return paged(await listRowErrors(ctx, params.jobId, p), p);
  },
);
