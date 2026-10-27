import { z } from "zod";
import { apiRoute, pageParams, paged } from "@/server/http";
import { listResults } from "@/server/services/results";

const q = z.object({
  classification: z.enum(["ACCEPTED", "NEEDS_REVIEW", "REJECTED_FROM_ZONE"]).optional(),
  zoneId: z.string().uuid().optional(),
  reasonCode: z.string().max(60).optional(),
  search: z.string().max(64).optional(),
  excluded: z.enum(["true", "false"]).optional(),
});

export const GET = apiRoute<{ jobId: string }>(
  { permission: "results:read" },
  async ({ req, ctx, params }) => {
    const url = new URL(req.url);
    const p = pageParams(url);
    const f = q.parse(Object.fromEntries([...url.searchParams].filter(([k]) => k in q.shape)));
    return paged(await listResults(ctx, params.jobId, { ...f, excluded: f.excluded === "true", ...p }), p);
  },
);
